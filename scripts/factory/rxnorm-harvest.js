/**
 * RxNorm Prescribable Subset bulk harvest orchestrator (PR-RXN-1).
 *
 * Streams RxNorm_full_prescribe_<MMDDYYYY>.zip from download.nlm.nih.gov,
 * delegates three-phase sequential RRF parsing to lib/rxnorm-rrf-streams.js,
 * emits ingredient-keyed lookup JSONL with license_metadata header,
 * zstd-compresses, uploads to R2.
 *
 * Architect 2026-05-27 production locks:
 *   LOCK 1 -- Sequential phase ordering enforced by explicit await chain
 *     in main(): Phase 1 (RXNREL) -> Phase 2 (RXNCONSO) -> Phase 3 (RXNSAT).
 *   LOCK 2 -- Strict 11-digit NDC normalization (delegated to lib).
 *
 * Output:
 *   R2 processed/bulk/rxnorm/<release_date>/rxcui-index.jsonl.zst
 *   R2 state/rxnorm-bulk-cursor.json
 *
 * Usage: node rxnorm-harvest.js --probe-json=/tmp/probe.json [--dry-run]
 *
 * Exit codes: 0 OK / 1 args / 2 download / 3 parse / 4 zstd / 5 R2 upload
 */

import { createWriteStream, writeFileSync, readFileSync, unlinkSync, statSync } from 'fs';
import { once } from 'events';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import StreamZip from 'node-stream-zip';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
    loadProductToIngredients, loadRxcuiMeta, loadIngredientAttributes, composeRecords,
} from './lib/rxnorm-rrf-streams.js';

const CURSOR_KEY = 'state/rxnorm-bulk-cursor.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

const ATTRIBUTION = 'This product uses publicly available data courtesy of the U.S. National Library of Medicine (NLM). NLM is not responsible for the product and does not endorse or recommend this or any other product.';

function parseArgs() {
    const args = { probeJson: null, dryRun: false };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--probe-json=')) args.probeJson = a.slice('--probe-json='.length);
        else if (a === '--dry-run') args.dryRun = true;
    }
    if (!args.probeJson) throw new Error('--probe-json=<path> required');
    return args;
}

async function fetchArchive(url, tmpPath) {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buf);
    return buf.length;
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

async function main() {
    const args = parseArgs();
    const probe = JSON.parse(readFileSync(args.probeJson, 'utf-8'));
    const { release_date, archive_url, parsed_header_checksum } = probe;
    if (!release_date || !archive_url) throw new Error('probe JSON missing required fields');
    console.log(`[RXNORM-HARVEST] release=${release_date} url=${archive_url}`);

    const tmpZip = join(tmpdir(), `rxnorm-${Date.now()}.zip`);
    const tmpJsonl = join(tmpdir(), `rxnorm-${Date.now()}.jsonl`);
    const tmpZst = `${tmpJsonl}.zst`;
    const droppedCounts = { malformed_ndc: 0 };

    try {
        const zipBytes = await fetchArchive(archive_url, tmpZip);
        console.log(`[RXNORM-HARVEST] downloaded zip=${zipBytes} bytes`);

        // LOCK 1: SEQUENTIAL three-phase fusion. Each phase awaited before
        // the next begins so Phase 3 sees fully-built Phase 1 projection.
        const zip = new StreamZip.async({ file: tmpZip });
        let meta, productToIngredients, attrs, mthsplUniiByRxcui, mthsplTelemetry;
        try {
            productToIngredients = await loadProductToIngredients(zip);
            console.log(`[RXNORM-HARVEST] phase 1 (RXNREL) complete: ${productToIngredients.size} product->ingredient edges`);
            ({ meta, mthsplUniiByRxcui, mthsplTelemetry } = await loadRxcuiMeta(zip));
            console.log(`[RXNORM-HARVEST] phase 2 (RXNCONSO) complete: ${meta.size} RxCUI metadata entries; ${mthsplUniiByRxcui.size} MTHSPL UNII bindings`);
            attrs = await loadIngredientAttributes(zip, productToIngredients, droppedCounts);
            console.log(`[RXNORM-HARVEST] phase 3 (RXNSAT) complete: ${attrs.size} ingredient-keyed attribute records`);
        } finally {
            await zip.close();
        }

        const records = composeRecords(meta, attrs, mthsplUniiByRxcui);
        console.log(`[RXNORM-HARVEST] composed ${records.length} ingredient records; dropped malformed NDCs=${droppedCounts.malformed_ndc}; skipped non-RXNORM SAB=${droppedCounts.skipped_nonrxnorm_sab ?? 0}`);
        console.log(`[RXNORM-HARVEST] MTHSPL UNII Rewire: total_mthspl_conso_rows=${mthsplTelemetry.total_mthspl_conso_rows} mthspl_su_rows=${mthsplTelemetry.mthspl_su_rows} mthspl_unii_harvested=${mthsplTelemetry.mthspl_unii_harvested} mthspl_unii_dropped_shape=${mthsplTelemetry.mthspl_unii_dropped_shape}`);
        if (droppedCounts.ndc_sab_distribution) {
            console.log(`[RXNORM-HARVEST] NDC SAB distribution: ${JSON.stringify(droppedCounts.ndc_sab_distribution)}`);
        }
        if (droppedCounts.malformed_ndc_samples?.length) {
            console.log(`[RXNORM-HARVEST] sample rejected NDC ATV values: ${JSON.stringify(droppedCounts.malformed_ndc_samples)}`);
        }

        const licenseMetadata = {
            upstream_source: 'rxnorm_prescribable',
            upstream_license: 'public-domain',
            upstream_release: release_date,
            ingestion_date: new Date().toISOString().slice(0, 10),
            attribution: ATTRIBUTION,
        };
        await writeJsonl(tmpJsonl, licenseMetadata, records);
        const jsonlBytes = statSync(tmpJsonl).size;
        zstdCompressFile(tmpJsonl, tmpZst);
        const zstBytes = statSync(tmpZst).size;
        console.log(`[RXNORM-HARVEST] jsonl=${jsonlBytes} bytes -> zst=${zstBytes} bytes`);

        if (args.dryRun) {
            console.log('[RXNORM-HARVEST] dry-run; skipping R2 upload + cursor write');
            return;
        }
        const client = makeR2Client();
        const bucket = process.env.R2_BUCKET;
        const dataKey = `processed/bulk/rxnorm/${release_date}/rxcui-index.jsonl.zst`;
        await uploadR2(client, bucket, dataKey, readFileSync(tmpZst), 'application/zstd');
        const cursor = {
            release_date, archive_url, parsed_header_checksum,
            archive_size_bytes: probe.archive_size_bytes ?? null,
            record_count: records.length,
            dropped_counts: droppedCounts,
            r2_data_key: dataKey, jsonl_bytes: jsonlBytes, zst_bytes: zstBytes,
            ingestion_date: new Date().toISOString(),
        };
        await uploadR2(client, bucket, CURSOR_KEY, Buffer.from(JSON.stringify(cursor, null, 2), 'utf-8'), 'application/json');
        console.log(`[RXNORM-HARVEST] R2 upload OK: ${dataKey} + ${CURSOR_KEY}`);
    } finally {
        for (const p of [tmpZip, tmpJsonl, tmpZst]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[RXNORM-HARVEST] FATAL:', err.message); process.exit(2); });
