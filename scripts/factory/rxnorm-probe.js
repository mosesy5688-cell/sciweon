/**
 * RxNorm Prescribable Subset bulk probe (PR-RXN-1; PR-RXN-1-probe-hotfix).
 *
 * Computes candidate URLs for first-Monday-of-month releases (last 3 months
 * window), HEAD-probes each, returns first 200. NLM disabled directory
 * indexing 2026-05-27 (HTTP 403 on /rxnorm/) but direct file URLs serve
 * unauthenticated per https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html.
 *
 * Downloads the resolved ZIP, inspects RXNCONSO.RRF first data row, computes
 * sorted SHA-256 fingerprint (release-version signal; RRF has no header
 * line so this is NOT a schema invariant -- column-count assertion at
 * harvester runtime is the schema gate).
 *
 * Output (stdout, single JSON line):
 *   { release_date, last_modified, archive_url, archive_size_bytes,
 *     parsed_header_checksum }
 *
 * Exit codes:
 *   0 OK   1 unreachable / no candidate 200   3 first-row read failed
 */

import { createHash } from 'crypto';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import StreamZip from 'node-stream-zip';
import { buildCandidateUrls, findLatestFullUrl } from './lib/rxnorm-release-discovery.js';
import { umlsDownloadUrl } from './lib/umls-auth.js';

const MONTHS_BACK = 3;

export function computeSortedHeaderChecksum(headerLine) {
    if (typeof headerLine !== 'string' || headerLine.length === 0) {
        throw new Error('headerLine must be non-empty string');
    }
    const columns = headerLine.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (columns.length === 0) throw new Error('zero columns after split');
    const canonical = [...columns].sort().join('|');
    return 'sha256-' + createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

async function fetchArchive(url, tmpPath) {
    const res = await fetch(umlsDownloadUrl(url), { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`);
    const lastMod = res.headers.get('last-modified');
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buf);
    return { lastMod, sizeBytes: buf.length };
}

async function readRxnconsoFirstRow(zipPath) {
    const zip = new StreamZip.async({ file: zipPath });
    try {
        const entries = await zip.entries();
        const target = Object.values(entries).find(e => !e.isDirectory && /(^|\/)RXNCONSO\.RRF$/i.test(e.name));
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
            if (buf.length > 65536) throw new Error('first row >64KB; malformed');
        }
        throw new Error('EOF before newline; RXNCONSO empty');
    } finally {
        await zip.close();
    }
}

async function main() {
    const candidates = buildCandidateUrls(MONTHS_BACK);
    let resolved;
    try { resolved = await findLatestFullUrl(candidates); }
    catch (err) { console.error(`[RXNORM-PROBE] release discovery failed: ${err.message}`); process.exit(1); }
    console.error(`[RXNORM-PROBE] resolved release_date=${resolved.release_date} url=${resolved.url}`);

    const tmpZip = join(tmpdir(), `rxnorm-probe-${Date.now()}.zip`);
    let lastMod, sizeBytes;
    try { ({ lastMod, sizeBytes } = await fetchArchive(resolved.url, tmpZip)); }
    catch (err) { console.error(`[RXNORM-PROBE] archive fetch failed: ${err.message}`); process.exit(1); }

    let firstRow;
    try { firstRow = await readRxnconsoFirstRow(tmpZip); }
    catch (err) { console.error(`[RXNORM-PROBE] first-row read failed: ${err.message}`); process.exit(3); }

    let checksum;
    try { checksum = computeSortedHeaderChecksum(firstRow); }
    catch (err) { console.error(`[RXNORM-PROBE] checksum compute failed: ${err.message}`); process.exit(3); }
    try { unlinkSync(tmpZip); } catch { /* ignore */ }

    const manifest = {
        release_date: resolved.release_date,
        last_modified: lastMod ?? resolved.last_modified ?? null,
        archive_url: resolved.url,
        archive_size_bytes: sizeBytes,
        parsed_header_checksum: checksum,
    };
    console.log(JSON.stringify(manifest));
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[RXNORM-PROBE] Fatal:', err); process.exit(1); });
