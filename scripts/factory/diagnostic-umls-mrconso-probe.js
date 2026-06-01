/**
 * UMLS Metathesaurus MRCONSO diagnostic row-dump probe (PR-UMLS-0, diagnostic-only).
 *
 * The FIRST UMLS ingest PR, per [[external_dataset_diagnostic_first]] -- which names
 * "Phase 1.9 UMLS MRSAT/MRCONSO/MRREL inbound" as exactly what it prevents (the RxNorm
 * RXNSAT column-order doc-fraud: rxnorm-rrf-streams.js:30-34 records the actual RRF
 * order CONTRADICTED the UMLS doc). So this probe NEVER parses by the UMLS column doc:
 * it dumps RAW POSITIONAL pipe-split rows so the real column->value mapping is verified
 * against data, and the per-SAB counts are flagged TENTATIVE until that verification.
 *
 * Does, in one run:
 *   1. EMPIRICALLY DISCOVER the release: BYTE-probe candidate Metathesaurus full-release
 *      URLs (recent <YYYY>{AA,AB}, reverse-chron) via the apiKey proxy and pick the FIRST
 *      whose head is a real ZIP (PK magic + size floor), NOT the first HTTP 200 -- the
 *      proxy returns 200 + a ~196-byte stub for a non-existent inner URL (PR-UMLS-0 Bug 1,
 *      which locked the phantom 2026AB). (--full-url=<inner> overrides.) No hardcoded URL.
 *   2. Download the winning zip; guard it (PK magic + 100MB floor) and dump the body head
 *      as evidence on anomaly (Bug 2: never discard the bytes); report compressed +
 *      MRCONSO.RRF uncompressed size (decides stream-vs-memory for PR-1).
 *   3. Dump the first N RAW positional rows + a TENTATIVE per-SAB tally at the
 *      doc-assumed SAB index (loudly flagged VERIFY-against-the-raw-dump).
 *
 * ZERO extraction / filter / stamp / mutation / R2 write. Exit: 0 OK / 1 args / 2 no
 * real release found / 3 download-or-anomaly-or-parse.
 */

import { createWriteStream, statSync, unlinkSync, openSync, readSync, closeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import StreamZip from 'node-stream-zip';
import { umlsApiKey, umlsDownloadUrl } from './lib/umls-auth.js';
import { findRrfEntry } from './lib/rxnorm-rrf-streams.js';
import {
    candidateMetathesaurusUrls, newSabTally, addSabTally, DOC_SAB_INDEX,
    classifyArchiveHead, ZIP_MAGIC, MIN_RELEASE_BYTES,
} from './lib/umls-mrconso-probe.js';

const SAMPLE_LIMIT = 100;
const HEAD_PROBE_BYTES = 512;     // bytes read off the stream per candidate during discovery
const FAIL_DUMP_BYTES = 2048;     // bytes captured for the terminal discovery-fail dump

// Byte-reading probe: fetch follows the proxy's 302 redirect, we read only the first
// ~512 bytes off the stream then cancel() -- the multi-GB body is NEVER downloaded here.
// PR-UMLS-0 Bug 1: a status-only probe trusted the proxy's false-200 (196-byte stub) for
// a non-existent inner URL (2026AB). Reading the magic bytes is the fix.
async function probeArchive(proxyUrl) {
    const res = await fetch(proxyUrl);
    let head = Buffer.alloc(0);
    try {
        if (res.body) {
            const reader = res.body.getReader();
            while (head.length < HEAD_PROBE_BYTES) {
                const { done, value } = await reader.read();
                if (done) break;
                head = Buffer.concat([head, Buffer.from(value)]);
            }
            try { await reader.cancel(); } catch { /* ignore */ }
        }
    } catch { /* partial head is fine for classification */ }
    return {
        status: res.status,
        finalUrl: res.url,
        contentType: res.headers.get('content-type') || '',
        contentLength: res.headers.get('content-length'),
        head: head.subarray(0, HEAD_PROBE_BYTES),
    };
}

async function downloadStream(url, tmpPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download HTTP ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));
    return {
        size: statSync(tmpPath).size,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        contentLength: res.headers.get('content-length'),
        finalUrl: res.url,
    };
}

function parseArgs() {
    let fullUrl = null, now = new Date();
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--full-url=')) fullUrl = a.slice('--full-url='.length);
    }
    umlsApiKey();  // fail-closed before any network call when UMLS_API_KEY absent
    return { fullUrl, now };
}

// Discover the release: BYTE-probe candidates (or the operator override) and return the
// FIRST whose head looks like a real ZIP (looks_real === true), NOT the first 200. The
// phantom newest candidate (e.g. 2026AB before it ships) returns a 200 + 196-byte non-PK
// stub -> fails magic -> skipped -> the real latest (2026AA) wins.
async function discoverRelease({ fullUrl, now }) {
    const candidates = fullUrl ? [fullUrl] : candidateMetathesaurusUrls(now);
    let last = null;
    for (const inner of candidates) {
        let p;
        try { p = await probeArchive(umlsDownloadUrl(inner)); }
        catch (e) {
            console.log(`[UMLS-PROBE] release-candidate status=err:${e.message} | inner=${inner}`);
            continue;
        }
        last = { inner, p };
        const c = classifyArchiveHead(p.head, p.contentLength);
        console.log(`[UMLS-PROBE] release-candidate status=${p.status} magic=${c.magic_hex} looks_real=${c.looks_real} content-length=${p.contentLength ?? 'none'} content-type=${p.contentType} | inner=${inner}`);
        if (c.looks_real) return inner;
    }
    // No real release: dump the last probed body head as evidence (Bug 2: never discard it).
    if (last) {
        const headText = last.p.head.subarray(0, FAIL_DUMP_BYTES).toString('utf-8');
        console.error('[UMLS-PROBE] DISCOVERY-FAIL no candidate looks like a real ZIP release.');
        console.error(`[UMLS-PROBE]   last-status=${last.p.status} final-url=${last.p.finalUrl}`);
        console.error(`[UMLS-PROBE]   content-type=${last.p.contentType} content-length=${last.p.contentLength ?? 'none'}`);
        console.error(`[UMLS-PROBE]   first-bytes-hex=${last.p.head.subarray(0, 4).toString('hex')}`);
        console.error(`[UMLS-PROBE]   body-head(<=${FAIL_DUMP_BYTES}B as text):\n${headText}`);
    }
    return null;
}

async function dumpMrconso(tmpZip) {
    const zip = new StreamZip.async({ file: tmpZip });
    try {
        const target = findRrfEntry(await zip.entries(), 'MRCONSO.RRF');
        if (!target) throw new Error('MRCONSO.RRF entry not found in ZIP');
        console.log(`[UMLS-PROBE] MRCONSO.RRF entry=${target.name} uncompressed_bytes=${target.size} (${(target.size / 1e9).toFixed(2)} GB) -- decides stream-vs-memory`);
        const samples = [];
        const tally = newSabTally();
        let total = 0, buf = '';
        const rl = (await zip.stream(target.name));
        // RAW positional read (line.split('|')) -- NOT csv-parse named columns. The whole
        // point is to verify the real column order against data, doc-immune. Tally per-SAB
        // over ALL rows at the tentative DOC_SAB_INDEX; keep the first N raw rows for review.
        await new Promise((resolve, reject) => {
            rl.on('data', (chunk) => {
                buf += chunk.toString('utf-8');
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                    if (!line) continue;
                    total++;
                    const fields = line.split('|');
                    addSabTally(tally, fields);
                    if (samples.length < SAMPLE_LIMIT) samples.push(fields);
                }
            });
            rl.on('end', resolve);
            rl.on('error', reject);
        });
        if (buf.trim()) { total++; const f = buf.trim().split('|'); addSabTally(tally, f); }
        return { total_rows: total, by_sab_tentative: tally, samples };
    } finally {
        await zip.close();
    }
}

// Read the first N bytes of a file (for the post-download magic + anomaly dump).
function readFileHead(path, n) {
    const fd = openSync(path, 'r');
    try {
        const buf = Buffer.alloc(n);
        const got = readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, got);
    } finally { closeSync(fd); }
}

async function main() {
    const args = parseArgs();
    const inner = await discoverRelease(args);
    if (!inner) { console.error('[UMLS-PROBE] no Metathesaurus full-release ZIP found (pass --full-url=<inner> from the NLM release page).'); process.exit(2); }
    console.log(`[UMLS-PROBE] release inner-url RESOLVED: ${inner}`);

    const tmpZip = join(tmpdir(), `umls-meta-${process.pid}.zip`);
    try {
        const dl = await downloadStream(umlsDownloadUrl(inner), tmpZip);
        console.log(`[UMLS-PROBE] downloaded zip bytes=${dl.size} (${(dl.size / 1e9).toFixed(2)} GB) status=${dl.status} content-type=${dl.contentType} content-length=${dl.contentLength ?? 'none'} final-url=${dl.finalUrl}`);

        // Guard the downloaded file BEFORE handing it to StreamZip (Bug 1+2): a proxy
        // false-200 stub is tiny + non-PK. Dump the evidence, never discard it.
        const head = readFileHead(tmpZip, HEAD_PROBE_BYTES);
        const firstFour = head.subarray(0, 4);
        if (dl.size < MIN_RELEASE_BYTES || !firstFour.equals(ZIP_MAGIC)) {
            console.error('[UMLS-PROBE] ANOMALY downloaded file is not a real Metathesaurus ZIP.');
            console.error(`[UMLS-PROBE]   file-size=${dl.size} (floor=${MIN_RELEASE_BYTES}) first-4-bytes-hex=${firstFour.toString('hex')}`);
            console.error(`[UMLS-PROBE]   status=${dl.status} content-type=${dl.contentType} content-length=${dl.contentLength ?? 'none'} final-url=${dl.finalUrl}`);
            console.error(`[UMLS-PROBE]   body-head(<=${HEAD_PROBE_BYTES}B as text):\n${head.toString('utf-8')}`);
            process.exit(3);
        }

        const summary = await dumpMrconso(tmpZip);
        console.log(`[UMLS-PROBE] MRCONSO total_rows=${summary.total_rows}`);
        console.log(`[UMLS-PROBE] TENTATIVE per-SAB (col index ${DOC_SAB_INDEX}, DOC-ASSUMED -- VERIFY against the raw rows below before trusting): ${JSON.stringify(summary.by_sab_tentative)}`);
        console.log(`[UMLS-PROBE] === RAW positional rows (first ${summary.samples.length}; verify which index holds SAB/CODE/STR/CUI) ===`);
        for (const r of summary.samples) console.log(`[UMLS-RAW] ${JSON.stringify(r)}`);
    } catch (err) {
        console.error(`[UMLS-PROBE] FATAL: ${err.message}`); process.exit(3);
    } finally {
        try { unlinkSync(tmpZip); } catch { /* ignore */ }
    }
    process.exit(0);
}

main().catch((err) => { console.error('[UMLS-PROBE] FATAL:', err.message); process.exit(3); });
