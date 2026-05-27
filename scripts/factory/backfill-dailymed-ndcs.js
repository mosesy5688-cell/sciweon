/**
 * DailyMed NDC Backfill (PR-RXN-1b-pre).
 *
 * One-shot offline backfiller. Reads the live aggregated drug-labels.jsonl
 * from R2, hydrates each record's `ndcs` array via fetchNdcs(setid), writes
 * the enriched dataset to a staging R2 key so operator can review before
 * promotion. Existing aggregated bundle is NEVER overwritten by this script.
 *
 * Architect 2026-05-28 spec (PR-RXN-1b-pre):
 *   - Throttled at fetcher's existing DELAY_MS (~2.8 req/sec, under NIH 10/s
 *     safe envelope).
 *   - fetchNdcs handles 429/5xx with exponential backoff + jitter; null
 *     return collapses to [] in record.
 *   - Records already carrying ndcs[] (incremental cron post-PR-1b-pre)
 *     are passed through unchanged (idempotent).
 *
 * R2 layout:
 *   Source: processed/aggregated/{latest_run_id}/drug-labels.jsonl(.zst)
 *           or local --input file path.
 *   Output: processed/backfill/dailymed-ndcs/{date}/drug-labels-with-ndcs.jsonl.zst
 *           processed/backfill/dailymed-ndcs/{date}/manifest.json
 *
 * Usage:
 *   node scripts/factory/backfill-dailymed-ndcs.js \
 *     [--input=path/to/drug-labels.jsonl]  // local override; default = R2 fetch
 *     [--limit=N]                          // cap setids processed (testing)
 *     [--dry-run]                          // no R2 PUT; manifest still emitted
 *
 * Exit codes: 0 OK / 1 args / 2 R2 download / 3 fetcher / 4 zstd / 5 R2 upload
 */

import { createWriteStream, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { once } from 'events';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { fetchNdcs, sleep, DELAY_MS } from '../ingestion/adapters/dailymed-fetcher.js';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const AGG_POINTER_KEY = 'processed/aggregated/latest.json';
const DRUG_LABELS_FILE = 'drug-labels.jsonl';

function parseArgs() {
    const args = { input: null, limit: Infinity, dryRun: false };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--input=')) args.input = a.slice(8);
        else if (a.startsWith('--limit=')) args.limit = parseInt(a.slice(8), 10) || Infinity;
        else if (a === '--dry-run') args.dryRun = true;
    }
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

function zstdDecompressFile(input, output) {
    const r = spawnSync('zstd', ['-d', '-f', '-o', output, input]);
    if (r.error) throw new Error(`zstd decompress: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`zstd exit ${r.status}: ${r.stderr?.toString()}`);
}

function zstdCompressFile(input, output) {
    const r = spawnSync('zstd', ['-f', '-o', output, input]);
    if (r.error) throw new Error(`zstd compress: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`zstd exit ${r.status}: ${r.stderr?.toString()}`);
}

async function r2Get(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await streamToBuffer(res.Body);
}

async function r2Put(client, bucket, key, body, contentType) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

async function loadDrugLabelsFromR2(client, bucket) {
    const pointerBuf = await r2Get(client, bucket, AGG_POINTER_KEY);
    const pointer = JSON.parse(pointerBuf.toString('utf-8'));
    const runId = pointer.run_id;
    if (!runId) throw new Error(`aggregated latest.json missing run_id: ${JSON.stringify(pointer)}`);
    // Aggregated bundle stores drug-labels.jsonl uncompressed alongside other files.
    const srcKey = `processed/aggregated/${runId}/${DRUG_LABELS_FILE}`;
    console.log(`[BACKFILL-NDC] Loading source: ${srcKey}`);
    const buf = await r2Get(client, bucket, srcKey);
    const text = buf.toString('utf-8');
    return { runId, srcKey, text };
}

function parseJsonl(text) {
    return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

async function backfillRecords(records, limit) {
    const manifest = {
        total: records.length,
        already_had_ndcs: 0,
        backfilled_success: 0,
        backfilled_empty: 0,
        backfill_failed: 0,
        skipped_no_setid: 0,
        non_drug_label_passthrough: 0,
    };
    const sampleFailures = [];
    let processedCount = 0;
    for (const rec of records) {
        // Only drug_label records have setid. Other adapter records (e.g., atc_class)
        // flow through unchanged.
        if (!rec || typeof rec.id !== 'string' || !rec.id.startsWith('sciweon::drug_label::')) {
            manifest.non_drug_label_passthrough++;
            continue;
        }
        if (Array.isArray(rec.ndcs) && rec.ndcs.length > 0) {
            manifest.already_had_ndcs++;
            continue;
        }
        if (!rec.setid) {
            manifest.skipped_no_setid++;
            rec.ndcs = [];
            continue;
        }
        if (processedCount >= limit) {
            rec.ndcs = [];
            continue;
        }
        const ndcs = await fetchNdcs(rec.setid);
        await sleep(DELAY_MS);
        processedCount++;
        if (ndcs === null) {
            manifest.backfill_failed++;
            if (sampleFailures.length < 10) sampleFailures.push(rec.setid);
            rec.ndcs = [];
        } else if (ndcs.length === 0) {
            manifest.backfilled_empty++;
            rec.ndcs = [];
        } else {
            manifest.backfilled_success++;
            rec.ndcs = ndcs;
        }
        if (processedCount % 25 === 0) {
            console.log(`[BACKFILL-NDC] progress: processed=${processedCount} success=${manifest.backfilled_success} empty=${manifest.backfilled_empty} failed=${manifest.backfill_failed}`);
        }
    }
    manifest.sample_failures = sampleFailures;
    return manifest;
}

function serializeJsonl(records) {
    return records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

async function main() {
    const args = parseArgs();
    const today = new Date().toISOString().slice(0, 10);
    const outDir = `processed/backfill/dailymed-ndcs/${today}`;
    const tmpJsonl = join(tmpdir(), `dailymed-ndcs-${Date.now()}.jsonl`);
    const tmpZst = `${tmpJsonl}.zst`;
    let client = null;
    let sourceTrace = { mode: null, key: null, run_id: null, path: null };
    let text;

    try {
        if (args.input) {
            sourceTrace = { mode: 'local', path: args.input };
            text = readFileSync(args.input, 'utf-8');
            console.log(`[BACKFILL-NDC] Loaded local input: ${args.input}`);
        } else {
            try { client = makeR2Client(); }
            catch (err) { console.error(`[BACKFILL-NDC] R2 client init: ${err.message}`); process.exit(1); }
            try {
                const loaded = await loadDrugLabelsFromR2(client, process.env.R2_BUCKET);
                sourceTrace = { mode: 'r2', key: loaded.srcKey, run_id: loaded.runId };
                text = loaded.text;
            } catch (err) {
                console.error(`[BACKFILL-NDC] R2 fetch: ${err.message}`);
                process.exit(2);
            }
        }

        const records = parseJsonl(text);
        console.log(`[BACKFILL-NDC] Loaded ${records.length} records; capping fetcher calls at limit=${args.limit === Infinity ? 'none' : args.limit}`);

        let manifest;
        try { manifest = await backfillRecords(records, args.limit); }
        catch (err) { console.error(`[BACKFILL-NDC] backfill: ${err.message}`); process.exit(3); }

        console.log(`[BACKFILL-NDC] manifest: ${JSON.stringify(manifest)}`);

        if (args.dryRun) {
            console.log('[BACKFILL-NDC] dry-run; skipping R2 upload');
            return;
        }
        if (!client) {
            console.error('[BACKFILL-NDC] local --input + no R2 client; cannot upload result. Use --dry-run for offline runs.');
            return;
        }

        try {
            writeFileSync(tmpJsonl, serializeJsonl(records));
            zstdCompressFile(tmpJsonl, tmpZst);
        } catch (err) {
            console.error(`[BACKFILL-NDC] write/compress: ${err.message}`);
            process.exit(4);
        }
        const jsonlBytes = statSync(tmpJsonl).size;
        const zstBytes = statSync(tmpZst).size;

        try {
            const bucket = process.env.R2_BUCKET;
            const dataKey = `${outDir}/drug-labels-with-ndcs.jsonl.zst`;
            const manifestKey = `${outDir}/manifest.json`;
            await r2Put(client, bucket, dataKey, readFileSync(tmpZst), 'application/zstd');
            const manifestPayload = {
                ...manifest, source: sourceTrace, output_key: dataKey,
                jsonl_bytes: jsonlBytes, zst_bytes: zstBytes,
                ingestion_date: new Date().toISOString(),
            };
            await r2Put(client, bucket, manifestKey, Buffer.from(JSON.stringify(manifestPayload, null, 2), 'utf-8'), 'application/json');
            console.log(`[BACKFILL-NDC] R2 upload OK: ${dataKey} + ${manifestKey}`);
        } catch (err) {
            console.error(`[BACKFILL-NDC] R2 upload: ${err.message}`);
            process.exit(5);
        }
    } finally {
        for (const p of [tmpJsonl, tmpZst]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[BACKFILL-NDC] FATAL:', err.message); process.exit(1); });
