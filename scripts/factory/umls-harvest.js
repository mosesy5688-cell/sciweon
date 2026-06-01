/**
 * UMLS MeSH (SAB=MSH) bulk harvest orchestrator (PR-UMLS-1; thin -- heavy logic in
 * lib/umls-concept-streams.js).
 *
 * Streams MRCONSO.RRF (2.34GB / 18,064,970 rows, run 26749404603) from the release zip
 * through makeRrfParser(MRCONSO_COLUMNS), feeding each row to ingestMrconsoRow(acc, row,
 * 'MSH'). MUST STREAM: only the byCode Map + 3 distinct-CODE Sets stay resident -- the
 * 2.34GB body is NEVER buffer-loaded. Emits one JSONL line per distinct MSH CODE
 * (D-descriptors + Q-qualifiers + C-supplementary, ALL record types per triple-lock),
 * zstd-compresses, uploads to R2, writes the cursor with the 3-SAB distinct-CODE telemetry.
 *
 * Phase boundary (RATIFIED): PR-1 = ARTIFACT ONLY. NO SID ledger / crosswalk / generator
 * touch; NO LANDED/LINKED claim (those are PR-2 gates). The anchor fields are computed into
 * each record (lib) for PR-2's stamper to consume.
 *
 * License SSoT: bulk acquisition tracker #47 (UMLS Metathesaurus, CAT0).
 *
 * Usage: node umls-harvest.js --probe-json=/tmp/umls-probe.json [--dry-run]
 * Exit codes: 0 OK / 1 args / 2 download / 3 parse / 4 zstd / 5 R2 upload
 */

import { createWriteStream, readFileSync, unlinkSync, statSync } from 'fs';
import { once } from 'events';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import StreamZip from 'node-stream-zip';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { umlsDownloadUrl } from './lib/umls-auth.js';
import { findRrfEntry } from './lib/rxnorm-rrf-streams.js';
import {
    MRCONSO_COLUMNS, MESH_SAB, makeRrfParser,
    newConceptAccumulator, ingestMrconsoRow, finalizeConcepts, buildMeshLicenseMetadata,
} from './lib/umls-concept-streams.js';

const CURSOR_KEY = 'state/umls-mesh-bulk-cursor.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function parseArgs() {
    const args = { probeJson: null, dryRun: false };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--probe-json=')) args.probeJson = a.slice('--probe-json='.length);
        else if (a === '--dry-run') args.dryRun = true;
    }
    if (!args.probeJson) throw new Error('--probe-json=<path> required');
    return args;
}

// Download the release zip to disk via the apiKey proxy (the multi-GB body cannot be
// arrayBuffer()'d into memory -- stream it to a temp file, then node-stream-zip random-
// accesses the central directory).
async function downloadZip(innerUrl, tmpPath) {
    const res = await fetch(umlsDownloadUrl(innerUrl), { method: 'GET' });
    if (!res.ok) throw new Error(`download HTTP ${res.status} ${res.statusText} on ${innerUrl}`);
    const out = createWriteStream(tmpPath);
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    return statSync(tmpPath).size;
}

// STREAM MRCONSO.RRF: zip.stream -> makeRrfParser(named cols) -> for-await rows. Only the
// accumulator (byCode Map + 3 Sets) is resident; the 2.34GB entry is never buffered.
async function streamMrconso(tmpZip) {
    const zip = new StreamZip.async({ file: tmpZip });
    const acc = newConceptAccumulator();
    let rows = 0;
    try {
        const target = findRrfEntry(await zip.entries(), 'MRCONSO.RRF');
        if (!target) throw new Error('MRCONSO.RRF entry not found in ZIP');
        console.log(`[UMLS-HARVEST] MRCONSO.RRF entry=${target.name} uncompressed_bytes=${target.size} (${(target.size / 1e9).toFixed(2)} GB) -- streaming`);
        const stream = await zip.stream(target.name);
        const parser = stream.pipe(makeRrfParser(MRCONSO_COLUMNS));
        for await (const row of parser) {
            ingestMrconsoRow(acc, row, MESH_SAB);
            if (++rows % 2_000_000 === 0) console.log(`[UMLS-HARVEST] streamed ${rows} rows; MSH concepts so far=${acc.byCode.size}`);
        }
    } finally {
        await zip.close();
    }
    console.log(`[UMLS-HARVEST] stream complete: ${rows} MRCONSO rows scanned`);
    return finalizeConcepts(acc);
}

async function writeJsonl(path, licenseMetadata, records) {
    const stream = createWriteStream(path, { encoding: 'utf-8' });
    if (!stream.write('#' + JSON.stringify({ license_metadata: licenseMetadata }) + '\n')) {
        await once(stream, 'drain');
    }
    for (const rec of records) {
        if (!stream.write(JSON.stringify(rec) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

function zstdCompressFile(input, output) {
    const result = spawnSync('zstd', ['-f', '-o', output, input]);
    if (result.error) throw new Error(`zstd spawn: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`zstd exit ${result.status}: ${result.stderr?.toString()}`);
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto', endpoint: process.env.R2_ENDPOINT,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
}

async function uploadR2(client, bucket, key, body, contentType) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// PM-mandated 3-SAB distinct-CODE telemetry + the PR-3 no-shard ceiling check.
function logDistinctCodeTelemetry(d) {
    console.log(`[UMLS-HARVEST] distinct-CODE per SAB: MSH=${d.MSH} SNOMEDCT_US=${d.SNOMEDCT_US} LNC=${d.LNC}`);
    const pass = d.SNOMEDCT_US < 1e6;
    console.log(`[UMLS-HARVEST] ceiling-check SNOMEDCT_US distinct<1e6 ? ${pass ? 'PASS' : 'FAIL'} (de-risks PR-3 no-shard)`);
}

async function main() {
    const args = parseArgs();
    const probe = JSON.parse(readFileSync(args.probeJson, 'utf-8'));
    const { release, inner_url } = probe;
    if (!release || !inner_url) throw new Error('probe JSON missing required fields (release, inner_url)');
    console.log(`[UMLS-HARVEST] release=${release} inner_url=${inner_url}`);

    const tmpZip = join(tmpdir(), `umls-${Date.now()}.zip`);
    const tmpJsonl = join(tmpdir(), `umls-mesh-${Date.now()}.jsonl`);
    const tmpZst = `${tmpJsonl}.zst`;

    try {
        const zipBytes = await downloadZip(inner_url, tmpZip);
        console.log(`[UMLS-HARVEST] downloaded zip=${zipBytes} bytes (${(zipBytes / 1e9).toFixed(2)} GB)`);

        const { concepts, distinctCodeBySab } = await streamMrconso(tmpZip);
        console.log(`[UMLS-HARVEST] MeSH concepts (distinct MSH CODEs)=${concepts.length}`);
        logDistinctCodeTelemetry(distinctCodeBySab);

        const ingestionDate = new Date().toISOString().slice(0, 10);
        const licenseMetadata = buildMeshLicenseMetadata(release, ingestionDate);
        await writeJsonl(tmpJsonl, licenseMetadata, concepts);
        const jsonlBytes = statSync(tmpJsonl).size;
        zstdCompressFile(tmpJsonl, tmpZst);
        const zstBytes = statSync(tmpZst).size;
        console.log(`[UMLS-HARVEST] jsonl=${jsonlBytes} bytes -> zst=${zstBytes} bytes`);

        if (args.dryRun) {
            console.log('[UMLS-HARVEST] dry-run; skipping R2 upload + cursor write');
            return;
        }
        const client = makeR2Client();
        const bucket = process.env.R2_BUCKET;
        const dataKey = `processed/bulk/umls/${release}/mesh-concepts.jsonl.zst`;
        await uploadR2(client, bucket, dataKey, readFileSync(tmpZst), 'application/zstd');
        const cursor = {
            release, inner_url,
            record_count: concepts.length,
            distinct_code_by_sab: distinctCodeBySab,
            r2_data_key: dataKey, jsonl_bytes: jsonlBytes, zst_bytes: zstBytes,
            ingestion_date: new Date().toISOString(),
        };
        await uploadR2(client, bucket, CURSOR_KEY, Buffer.from(JSON.stringify(cursor, null, 2), 'utf-8'), 'application/json');
        console.log(`[UMLS-HARVEST] R2 upload OK: ${dataKey} + ${CURSOR_KEY}`);
    } finally {
        for (const p of [tmpZip, tmpJsonl, tmpZst]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[UMLS-HARVEST] FATAL:', err.message); process.exit(2); });
