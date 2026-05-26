/**
 * FDA SRS bulk probe (Phase 1.8 PR-FDA-SRS-1).
 *
 * Probes precision.fda.gov UNII archive to discover the latest release
 * date and TSV inner-entry filename, computes a sorted-header SHA-256
 * schema checksum (Rail 7 stability), and emits a JSON manifest used
 * by check-version + harvest jobs.
 *
 * Architect-locked rails covered here:
 *   Rail 7 -- Schema break P0 hard-fail via sorted-header SHA-256
 *   Rail 8 -- target_entry_name resolution + emission for harvester SSoT
 *
 * Output (stdout, single JSON line):
 *   {
 *     release_date: 'YYYY-MM-DD',
 *     last_modified: '<HTTP Last-Modified header>',
 *     target_entry_name: '<inner TSV filename inside ZIP>',
 *     parsed_header_checksum: 'sha256-<hex>',
 *     archive_url: '<download URL>'
 *   }
 *
 * Exit codes:
 *   0  probe succeeded
 *   1  upstream unreachable / archive HEAD failed
 *   2  ZIP entry resolution failed (no TSV-like inner file)
 *   3  TSV header parse failed (zero-column / malformed header line)
 */

import { createHash } from 'crypto';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import StreamZip from 'node-stream-zip';

const ARCHIVE_URL = 'https://precision.fda.gov/uniisearch/archive/latest/UNII_Data.zip';

export function computeSortedHeaderChecksum(headerLine) {
    if (typeof headerLine !== 'string' || headerLine.length === 0) {
        throw new Error('headerLine must be non-empty string');
    }
    const columns = headerLine.split('\t').map(c => c.trim()).filter(c => c.length > 0);
    if (columns.length === 0) throw new Error('zero columns after split');
    const canonical = [...columns].sort().join('|');
    return 'sha256-' + createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

export function parseLastModifiedToDate(lastModifiedHeader) {
    if (!lastModifiedHeader) return null;
    const d = new Date(lastModifiedHeader);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

async function fetchArchive(url, tmpPath) {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`);
    const lastMod = res.headers.get('last-modified');
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buf);
    return { lastMod, sizeBytes: buf.length };
}

async function resolveTargetEntry(zipPath) {
    const zip = new StreamZip.async({ file: zipPath });
    try {
        const entries = await zip.entries();
        const tsvCandidates = Object.values(entries)
            .filter(e => !e.isDirectory)
            .filter(e => /\.(txt|tsv)$/i.test(e.name))
            .filter(e => /UNII/i.test(e.name));
        if (tsvCandidates.length === 0) {
            throw new Error('no TSV-like UNII* entry inside ZIP');
        }
        // Prefer the largest entry when multiple match (Records vs Names etc).
        tsvCandidates.sort((a, b) => b.size - a.size);
        return { name: tsvCandidates[0].name, size: tsvCandidates[0].size };
    } finally {
        await zip.close();
    }
}

async function readHeaderLine(zipPath, entryName) {
    const zip = new StreamZip.async({ file: zipPath });
    try {
        const stream = await zip.stream(entryName);
        let buf = '';
        for await (const chunk of stream) {
            buf += chunk.toString('utf-8');
            const nl = buf.indexOf('\n');
            if (nl !== -1) return buf.slice(0, nl).replace(/\r$/, '');
            if (buf.length > 65536) throw new Error('header line >64KB; malformed?');
        }
        throw new Error('EOF before newline; TSV has no header');
    } finally {
        await zip.close();
    }
}

async function main() {
    const tmpZip = join(tmpdir(), `fda-srs-probe-${Date.now()}.zip`);
    let lastMod, sizeBytes;
    try {
        ({ lastMod, sizeBytes } = await fetchArchive(ARCHIVE_URL, tmpZip));
    } catch (err) {
        console.error(`[FDA-SRS-PROBE] archive fetch failed: ${err.message}`);
        process.exit(1);
    }
    let target;
    try { target = await resolveTargetEntry(tmpZip); }
    catch (err) { console.error(`[FDA-SRS-PROBE] entry resolution failed: ${err.message}`); process.exit(2); }
    let header;
    try { header = await readHeaderLine(tmpZip, target.name); }
    catch (err) { console.error(`[FDA-SRS-PROBE] header parse failed: ${err.message}`); process.exit(3); }
    let checksum;
    try { checksum = computeSortedHeaderChecksum(header); }
    catch (err) { console.error(`[FDA-SRS-PROBE] checksum compute failed: ${err.message}`); process.exit(3); }
    try { unlinkSync(tmpZip); } catch { /* ignore */ }

    const manifest = {
        release_date: parseLastModifiedToDate(lastMod) ?? new Date().toISOString().slice(0, 10),
        last_modified: lastMod ?? null,
        archive_url: ARCHIVE_URL,
        target_entry_name: target.name,
        target_entry_size_bytes: target.size,
        parsed_header_checksum: checksum,
        archive_size_bytes: sizeBytes,
    };
    console.log(JSON.stringify(manifest));
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[FDA-SRS-PROBE] Fatal:', err); process.exit(1); });
