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
 *   1. EMPIRICALLY DISCOVER the release: status-probe candidate Metathesaurus
 *      full-release URLs (recent <YYYY>{AA,AB}, reverse-chron) via the apiKey proxy;
 *      report each status. (--full-url=<inner> overrides if the operator reads the real
 *      URL off the NLM release page.) No hardcoded "the" URL; the probe reports which 200s.
 *   2. Download the winning zip; report compressed + MRCONSO.RRF uncompressed size
 *      (decides stream-vs-memory for PR-1).
 *   3. Dump the first N RAW positional rows + a TENTATIVE per-SAB tally at the
 *      doc-assumed SAB index (loudly flagged VERIFY-against-the-raw-dump).
 *
 * ZERO extraction / filter / stamp / mutation / R2 write. Exit: 0 OK / 1 args / 2 no
 * release found / 3 download-or-parse.
 */

import { createWriteStream, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import StreamZip from 'node-stream-zip';
import { umlsApiKey, umlsDownloadUrl } from './lib/umls-auth.js';
import { findRrfEntry } from './lib/rxnorm-rrf-streams.js';
import { candidateMetathesaurusUrls, newSabTally, addSabTally, DOC_SAB_INDEX } from './lib/umls-mrconso-probe.js';

const SAMPLE_LIMIT = 100;

async function statusProbe(url) {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1' } });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return res.status;
}

async function downloadStream(url, tmpPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download HTTP ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));
    return statSync(tmpPath).size;
}

function parseArgs() {
    let fullUrl = null, now = new Date();
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--full-url=')) fullUrl = a.slice('--full-url='.length);
    }
    umlsApiKey();  // fail-closed before any network call when UMLS_API_KEY absent
    return { fullUrl, now };
}

// Discover the release: probe candidates (or the operator override) and return the winner.
async function discoverRelease({ fullUrl, now }) {
    const candidates = fullUrl ? [fullUrl] : candidateMetathesaurusUrls(now);
    for (const inner of candidates) {
        let status;
        try { status = await statusProbe(umlsDownloadUrl(inner)); }
        catch (e) { status = `err:${e.message}`; }
        console.log(`[UMLS-PROBE] release-candidate status=${status} | inner=${inner}`);
        if (status === 200 || status === 206) return inner;
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

async function main() {
    const args = parseArgs();
    const inner = await discoverRelease(args);
    if (!inner) { console.error('[UMLS-PROBE] no Metathesaurus full-release URL returned 200 (pass --full-url=<inner> from the NLM release page).'); process.exit(2); }
    console.log(`[UMLS-PROBE] release inner-url RESOLVED: ${inner}`);

    const tmpZip = join(tmpdir(), `umls-meta-${process.pid}.zip`);
    try {
        const zbytes = await downloadStream(umlsDownloadUrl(inner), tmpZip);
        console.log(`[UMLS-PROBE] downloaded zip bytes=${zbytes} (${(zbytes / 1e9).toFixed(2)} GB)`);
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
