/**
 * DailyMed NDC fan-in cumulative backfill (PR-RXN-1b-fanin-patch, 2026-05-28).
 *
 * One-shot operator-dispatched script. Targets the F1+adapter-bridge fan-in
 * cumulative (NOT the F3 aggregated bundle). After PR-185 (Path Y deep-merge
 * activation), the F3 aggregated drug-labels.jsonl axis is protected from
 * cur-replace-prev erasure. But the F2 cross-linker reads adapter-cumulative
 * built from fan-in cumulative, NOT the F3 aggregated bundle. Historical 915
 * fan-in records still lack ndcs[] (pre PR-RXN-1b-pre normalize() shape) -->
 * hydrateLabelRxcuisFromNdcs second gate skips all 915 --> compound side
 * cross-link backlink stays at 0%.
 *
 * This patch ONLY touches drug_label records (type-isolated). Other adapter
 * record types (atc_class, etc.) pass through unchanged.
 *
 * Architect 2026-05-28 spec:
 *   - Streaming gunzip -> line-by-line parse -> stream gzip (no full
 *     in-memory materialization beyond per-record allocation)
 *   - Type-isolated hydration: only drug_label records get fetchNdcs(setid)
 *   - Atomic write guard: build payload to local .tmp file, verify record
 *     count parity (in == out), THEN PUT to live R2 fan-in key
 *   - Idempotent: records already carrying non-empty ndcs[] skip fetcher
 *   - Rate-limit defense: fetchNdcs already has exp-backoff + jitter (PR-180)
 *
 * R2 layout:
 *   Pointer:   processed/aggregated/fanin-latest.json (JSON with .pointer field)
 *   Cumulative: processed/aggregated/<pointer>/all-records.jsonl.gz
 *   Manifest:  processed/backfill/dailymed-fanin/<date>/manifest.json
 *
 * Usage:
 *   node scripts/factory/backfill-dailymed-fanin-ndcs.js [--dry-run]
 *
 * Exit codes: 0 OK / 1 args / 2 R2 download / 3 stream/parse / 4 gzip /
 *             5 parity / 6 R2 upload
 */

import { createWriteStream, readFileSync, statSync, unlinkSync } from 'fs';
import { createGunzip, createGzip } from 'zlib';
import { once } from 'events';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import readline from 'readline';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { fetchNdcs, sleep, DELAY_MS } from '../ingestion/adapters/dailymed-fetcher.js';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const FANIN_POINTER_KEY = 'processed/aggregated/fanin-latest.json';

function parseArgs() {
    const args = { dryRun: false };
    for (const a of process.argv.slice(2)) if (a === '--dry-run') args.dryRun = true;
    return args;
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto', endpoint: process.env.R2_ENDPOINT,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

/**
 * Pure-function transform: given a JSONL line, hydrate ndcs[] on drug_label
 * records that lack it. Non-drug-label lines pass through unchanged. Drug
 * labels with existing non-empty ndcs[] also pass through (idempotent).
 * Returns { line: newLine, counters: { hydrated, skipped_already, skipped_other_type, fetcher_failed } }.
 */
export async function hydrateOneLine(rawLine, fetchNdcsImpl) {
    const stats = { hydrated: 0, skipped_already: 0, skipped_other_type: 0, fetcher_failed: 0, failed_setid: null };
    if (!rawLine.trim()) return { line: '', stats };
    let rec;
    try { rec = JSON.parse(rawLine); }
    catch { return { line: rawLine, stats }; }  // malformed line passthrough (defensive)
    if (typeof rec?.id !== 'string' || !rec.id.startsWith('sciweon::drug_label::')) {
        stats.skipped_other_type = 1;
        return { line: rawLine, stats };
    }
    if (Array.isArray(rec.ndcs) && rec.ndcs.length > 0) {
        stats.skipped_already = 1;
        return { line: rawLine, stats };
    }
    if (!rec.setid) {
        stats.fetcher_failed = 1;
        return { line: rawLine, stats };
    }
    const ndcs = await fetchNdcsImpl(rec.setid);
    if (ndcs === null) {
        stats.fetcher_failed = 1;
        stats.failed_setid = rec.setid;
        rec.ndcs = [];
    } else {
        stats.hydrated = 1;
        rec.ndcs = ndcs;
    }
    return { line: JSON.stringify(rec) + '\n', stats };
}

async function streamHydrate(inputBuffer, fetchNdcsImpl, outputPath, sleepMs) {
    const totals = {
        total_lines: 0,
        drug_labels: 0,
        hydrated: 0,
        skipped_already_had_ndcs: 0,
        skipped_other_type: 0,
        fetcher_failed: 0,
        sample_failures: [],
    };
    const outStream = createWriteStream(outputPath, { encoding: 'utf-8' });
    const gzipOut = createGzip();
    gzipOut.pipe(outStream);
    const inGunzip = Readable.from(inputBuffer).pipe(createGunzip());
    const rl = readline.createInterface({ input: inGunzip, crlfDelay: Infinity });

    for await (const line of rl) {
        totals.total_lines++;
        if (!line) continue;
        const { line: newLine, stats } = await hydrateOneLine(line, fetchNdcsImpl);
        if (stats.skipped_other_type) totals.skipped_other_type++;
        else {
            totals.drug_labels++;
            if (stats.hydrated) totals.hydrated++;
            if (stats.skipped_already) totals.skipped_already_had_ndcs++;
            if (stats.fetcher_failed) {
                totals.fetcher_failed++;
                if (stats.failed_setid && totals.sample_failures.length < 10) totals.sample_failures.push(stats.failed_setid);
            }
            if (stats.hydrated && sleepMs > 0) await sleep(sleepMs);
        }
        if (!gzipOut.write(newLine)) await once(gzipOut, 'drain');
        if (totals.total_lines % 1000 === 0) {
            console.log(`[BACKFILL-FANIN-NDC] progress lines=${totals.total_lines} drug_labels=${totals.drug_labels} hydrated=${totals.hydrated} fetcher_failed=${totals.fetcher_failed}`);
        }
    }
    gzipOut.end();
    await once(outStream, 'finish');
    return totals;
}

async function main() {
    const args = parseArgs();
    const today = new Date().toISOString().slice(0, 10);
    const tmpGz = join(tmpdir(), `fanin-ndc-${Date.now()}.jsonl.gz`);
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    let pointerObj;
    try {
        const ptrBuf = await streamToBuffer((await client.send(new GetObjectCommand({ Bucket: bucket, Key: FANIN_POINTER_KEY }))).Body);
        pointerObj = JSON.parse(ptrBuf.toString('utf-8'));
    } catch (err) { console.error(`[BACKFILL-FANIN-NDC] pointer fetch: ${err.message}`); process.exit(2); }
    const fanInPtr = pointerObj.pointer;
    if (!fanInPtr) { console.error(`[BACKFILL-FANIN-NDC] pointer missing .pointer field: ${JSON.stringify(pointerObj)}`); process.exit(2); }
    const fanInKey = `processed/aggregated/${fanInPtr}/all-records.jsonl.gz`;
    console.log(`[BACKFILL-FANIN-NDC] fan-in pointer=${fanInPtr} key=${fanInKey}`);

    let inputBuffer, inputBytes;
    try {
        inputBuffer = await streamToBuffer((await client.send(new GetObjectCommand({ Bucket: bucket, Key: fanInKey }))).Body);
        inputBytes = inputBuffer.length;
        console.log(`[BACKFILL-FANIN-NDC] downloaded fan-in cumulative: ${(inputBytes / 1024).toFixed(1)} KB gz`);
    } catch (err) { console.error(`[BACKFILL-FANIN-NDC] fan-in download: ${err.message}`); process.exit(2); }

    let stats;
    try {
        stats = await streamHydrate(inputBuffer, fetchNdcs, tmpGz, DELAY_MS);
        console.log(`[BACKFILL-FANIN-NDC] hydration complete: ${JSON.stringify(stats)}`);
    } catch (err) {
        console.error(`[BACKFILL-FANIN-NDC] stream hydrate: ${err.message}`);
        try { unlinkSync(tmpGz); } catch { /* ignore */ }
        process.exit(3);
    }

    const outputBytes = statSync(tmpGz).size;
    const outputBuffer = readFileSync(tmpGz);

    let outputLines = 0;
    try {
        const verify = await new Promise((resolve, reject) => {
            const rl2 = readline.createInterface({ input: Readable.from(outputBuffer).pipe(createGunzip()), crlfDelay: Infinity });
            let n = 0;
            rl2.on('line', () => n++);
            rl2.on('close', () => resolve(n));
            rl2.on('error', reject);
        });
        outputLines = verify;
    } catch (err) { console.error(`[BACKFILL-FANIN-NDC] output verify: ${err.message}`); process.exit(4); }

    if (outputLines !== stats.total_lines) {
        console.error(`[BACKFILL-FANIN-NDC] PARITY FAIL: input lines=${stats.total_lines} output lines=${outputLines}; refusing R2 PUT to protect fan-in`);
        try { unlinkSync(tmpGz); } catch { /* ignore */ }
        process.exit(5);
    }
    console.log(`[BACKFILL-FANIN-NDC] parity green: ${stats.total_lines} lines in == ${outputLines} lines out`);

    const inputSha = createHash('sha256').update(inputBuffer).digest('hex');
    const outputSha = createHash('sha256').update(outputBuffer).digest('hex');
    const manifest = {
        execution_timestamp: new Date().toISOString(),
        fanin_pointer: fanInPtr, fanin_key: fanInKey,
        input_bytes: inputBytes, output_bytes: outputBytes,
        input_sha256: inputSha, output_sha256: outputSha,
        stats, dry_run: args.dryRun,
    };

    if (args.dryRun) {
        console.log(`[BACKFILL-FANIN-NDC] dry-run; skipping R2 PUT to fan-in cumulative + manifest. Manifest preview: ${JSON.stringify(manifest)}`);
        try { unlinkSync(tmpGz); } catch { /* ignore */ }
        return;
    }
    try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: fanInKey, Body: outputBuffer, ContentType: 'application/gzip' }));
        console.log(`[BACKFILL-FANIN-NDC] PUT OK: ${fanInKey} (${outputBytes} bytes, sha256=${outputSha.slice(0, 24)}...)`);
        const manifestKey = `processed/backfill/dailymed-fanin/${today}/manifest.json`;
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: manifestKey, Body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), ContentType: 'application/json' }));
        console.log(`[BACKFILL-FANIN-NDC] manifest written: ${manifestKey}`);
    } catch (err) { console.error(`[BACKFILL-FANIN-NDC] R2 upload: ${err.message}`); process.exit(6); }
    finally { try { unlinkSync(tmpGz); } catch { /* ignore */ } }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[BACKFILL-FANIN-NDC] FATAL:', err.message); process.exit(1); });
