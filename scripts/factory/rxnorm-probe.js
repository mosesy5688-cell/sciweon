/**
 * RxNorm Prescribable Subset bulk probe (PR-RXN-1).
 *
 * Probes download.nlm.nih.gov/rxnorm/ directory listing to discover the
 * latest RxNorm_full_prescribe_<MMDDYYYY>.zip release. Downloads the ZIP,
 * inspects RXNCONSO.RRF header (pipe-delimited), computes sorted-header
 * SHA-256 schema checksum (Rail 7), and emits JSON manifest used by
 * check-version + harvest jobs.
 *
 * Output (stdout, single JSON line):
 *   {
 *     release_date: 'YYYY-MM-DD',
 *     last_modified: '<HTTP Last-Modified>',
 *     archive_url: '<download URL>',
 *     archive_size_bytes: <int>,
 *     parsed_header_checksum: 'sha256-<hex>'
 *   }
 *
 * Exit codes:
 *   0 OK   1 unreachable   2 release listing parse failed   3 header parse failed
 */

import { createHash } from 'crypto';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import StreamZip from 'node-stream-zip';

const RXNORM_DIR_URL = 'https://download.nlm.nih.gov/rxnorm/';
const FILENAME_PATTERN = /RxNorm_full_prescribe_(\d{2})(\d{2})(\d{4})\.zip/g;

export function computeSortedHeaderChecksum(headerLine) {
    if (typeof headerLine !== 'string' || headerLine.length === 0) {
        throw new Error('headerLine must be non-empty string');
    }
    const columns = headerLine.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (columns.length === 0) throw new Error('zero columns after split');
    const canonical = [...columns].sort().join('|');
    return 'sha256-' + createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Discover latest RxNorm_full_prescribe_<MMDDYYYY>.zip from NLM directory.
 * Returns { filename, release_date (YYYY-MM-DD) }.
 */
export function pickLatestPrescribableRelease(dirHtml) {
    if (typeof dirHtml !== 'string' || dirHtml.length === 0) {
        throw new Error('empty directory listing');
    }
    const seen = new Map();  // key=YYYY-MM-DD, value=filename
    for (const match of dirHtml.matchAll(FILENAME_PATTERN)) {
        const [filename, mm, dd, yyyy] = match;
        const isoDate = `${yyyy}-${mm}-${dd}`;
        seen.set(isoDate, filename);
    }
    if (seen.size === 0) throw new Error('no RxNorm_full_prescribe_*.zip found in listing');
    const sortedDates = [...seen.keys()].sort();
    const latestDate = sortedDates[sortedDates.length - 1];
    return { filename: seen.get(latestDate), release_date: latestDate };
}

async function fetchDirListing(url) {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`);
    return await res.text();
}

async function fetchArchive(url, tmpPath) {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`);
    const lastMod = res.headers.get('last-modified');
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buf);
    return { lastMod, sizeBytes: buf.length };
}

async function readRxnconsoHeader(zipPath) {
    const zip = new StreamZip.async({ file: zipPath });
    try {
        const entries = await zip.entries();
        const target = Object.values(entries).find(e => !e.isDirectory && /RXNCONSO\.RRF$/i.test(e.name));
        if (!target) throw new Error('no RXNCONSO.RRF entry inside ZIP');
        const stream = await zip.stream(target.name);
        let buf = '';
        for await (const chunk of stream) {
            buf += chunk.toString('utf-8');
            const nl = buf.indexOf('\n');
            if (nl !== -1) {
                stream.destroy();
                return buf.slice(0, nl).replace(/\r$/, '');
            }
            if (buf.length > 65536) throw new Error('header >64KB; malformed');
        }
        throw new Error('EOF before newline; RXNCONSO has no header');
    } finally {
        await zip.close();
    }
}

async function main() {
    let dirHtml;
    try { dirHtml = await fetchDirListing(RXNORM_DIR_URL); }
    catch (err) { console.error(`[RXNORM-PROBE] dir fetch failed: ${err.message}`); process.exit(1); }

    let latest;
    try { latest = pickLatestPrescribableRelease(dirHtml); }
    catch (err) { console.error(`[RXNORM-PROBE] listing parse failed: ${err.message}`); process.exit(2); }

    const archive_url = RXNORM_DIR_URL + latest.filename;
    const tmpZip = join(tmpdir(), `rxnorm-probe-${Date.now()}.zip`);
    let lastMod, sizeBytes;
    try { ({ lastMod, sizeBytes } = await fetchArchive(archive_url, tmpZip)); }
    catch (err) { console.error(`[RXNORM-PROBE] archive fetch failed: ${err.message}`); process.exit(1); }

    let header;
    try { header = await readRxnconsoHeader(tmpZip); }
    catch (err) { console.error(`[RXNORM-PROBE] header read failed: ${err.message}`); process.exit(3); }

    let checksum;
    try { checksum = computeSortedHeaderChecksum(header); }
    catch (err) { console.error(`[RXNORM-PROBE] checksum compute failed: ${err.message}`); process.exit(3); }
    try { unlinkSync(tmpZip); } catch { /* ignore */ }

    const manifest = {
        release_date: latest.release_date,
        last_modified: lastMod ?? null,
        archive_url,
        archive_size_bytes: sizeBytes,
        parsed_header_checksum: checksum,
    };
    console.log(JSON.stringify(manifest));
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[RXNORM-PROBE] Fatal:', err); process.exit(1); });
