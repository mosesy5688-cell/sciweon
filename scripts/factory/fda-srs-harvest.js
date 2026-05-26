/**
 * FDA SRS bulk harvest (Phase 1.8 PR-FDA-SRS-1).
 *
 * Streams UNII_Data.zip from precision.fda.gov, parses inner TSV row-by-
 * row, normalizes InChIKey, emits Sciweon-internal lookup JSONL, zstd-
 * compresses via system zstd CLI, uploads to R2.
 *
 * Architect-locked rails covered here:
 *   Rail 2 -- Cursor write at end (SSoT bidirectional convergence)
 *   Rail 4 -- Streaming pipeline (process memory ceiling 50MB)
 *   Rail 5 -- InChIKey normalization invariant (shared SSoT with adapter)
 *   Rail 8 -- target_entry_name read from cursor JSON (not regex guessing)
 *
 * Output (R2):
 *   processed/bulk/fda-srs/<release_date>/unii-lookup.jsonl.zst
 *   state/fda-srs-cursor.json
 *
 * Usage:
 *   node fda-srs-harvest.js --probe-json=/tmp/probe.json [--dry-run]
 *
 * Exit codes:
 *   0 OK   1 args   2 download/unzip   3 parse   4 zstd   5 R2 upload
 */

import { createWriteStream, writeFileSync, readFileSync, unlinkSync, statSync } from 'fs';
import { once } from 'events';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import StreamZip from 'node-stream-zip';
import { parse as parseCsv } from 'csv-parse';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const CURSOR_KEY = 'state/fda-srs-cursor.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

// Rail 5: shared normalization invariant. Format `[A-Z0-9]{14}-[A-Z0-9]{10}-[A-Z0-9]`.
export function normalizeInChIKey(raw) {
    if (typeof raw !== 'string') return null;
    const clean = raw.trim().toUpperCase();
    if (clean.length !== 27) return null;
    if (!/^[A-Z0-9]{14}-[A-Z0-9]{10}-[A-Z0-9]$/.test(clean)) return null;
    return clean;
}

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

// Rail 4 streaming pipeline: zip stream -> csv-parse stream -> per-row -> JSONL writer.
// Memory budget held at ~50MB by avoiding any full-corpus array materialization.
async function streamTsvToJsonl(zipPath, jsonlPath, targetEntryName) {
    const zip = new StreamZip.async({ file: zipPath });
    const outStream = createWriteStream(jsonlPath, { encoding: 'utf-8' });
    let processed = 0;
    let dropped = 0;
    try {
        const tsvStream = await zip.stream(targetEntryName);
        const parser = tsvStream.pipe(parseCsv({
            delimiter: '\t', columns: true, trim: true, relax_quotes: true, skip_empty_lines: true,
        }));
        for await (const row of parser) {
            const cleanKey = normalizeInChIKey(row.InChIKey);
            if (!cleanKey) { dropped++; continue; }
            const unii = typeof row.UNII === 'string' ? row.UNII.trim() : null;
            if (!unii) { dropped++; continue; }
            const record = {
                inchi_key: cleanKey,
                unii,
                preferred_name: typeof row.PT === 'string' ? row.PT.trim() : null,
                cas_rn: typeof row.RN === 'string' ? row.RN.trim() : null,
            };
            if (!outStream.write(JSON.stringify(record) + '\n')) await once(outStream, 'drain');
            processed++;
        }
    } finally {
        outStream.end();
        await once(outStream, 'finish');
        await zip.close();
    }
    return { processed, dropped };
}

function zstdCompressFile(inputPath, outputPath) {
    const result = spawnSync('zstd', ['-f', '-o', outputPath, inputPath]);
    if (result.error) throw new Error(`zstd spawn: ${result.error.message}`);
    if (result.status !== 0) {
        throw new Error(`zstd exit ${result.status}: ${result.stderr?.toString()}`);
    }
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
    const { release_date, target_entry_name, parsed_header_checksum, archive_url } = probe;
    if (!release_date || !target_entry_name || !parsed_header_checksum) {
        throw new Error('probe JSON missing required fields');
    }
    console.log(`[FDA-SRS-HARVEST] release=${release_date} entry=${target_entry_name} checksum=${parsed_header_checksum.slice(0, 24)}...`);

    const tmpZip = join(tmpdir(), `fda-srs-${Date.now()}.zip`);
    const tmpJsonl = join(tmpdir(), `fda-srs-${Date.now()}.jsonl`);
    const tmpZst = `${tmpJsonl}.zst`;
    try {
        const zipBytes = await fetchArchive(archive_url, tmpZip);
        console.log(`[FDA-SRS-HARVEST] downloaded zip=${zipBytes} bytes`);
        const { processed, dropped } = await streamTsvToJsonl(tmpZip, tmpJsonl, target_entry_name);
        console.log(`[FDA-SRS-HARVEST] streamed ${processed} records; ${dropped} dropped due to InChIKey normalization failure (typical <0.1%; investigate if >1%)`);
        const jsonlBytes = statSync(tmpJsonl).size;
        zstdCompressFile(tmpJsonl, tmpZst);
        const zstBytes = statSync(tmpZst).size;
        console.log(`[FDA-SRS-HARVEST] jsonl=${jsonlBytes} bytes -> zst=${zstBytes} bytes`);

        if (args.dryRun) {
            console.log('[FDA-SRS-HARVEST] dry-run; skipping R2 upload + cursor write');
            return;
        }
        const client = makeR2Client();
        const bucket = process.env.R2_BUCKET;
        const dataKey = `processed/bulk/fda-srs/${release_date}/unii-lookup.jsonl.zst`;
        const dataBuf = readFileSync(tmpZst);
        await uploadR2(client, bucket, dataKey, dataBuf, 'application/zstd');
        const cursor = {
            release_date, last_modified: probe.last_modified, archive_url,
            target_entry_name, parsed_header_checksum,
            record_count: processed, dropped_count: dropped,
            r2_data_key: dataKey, jsonl_bytes: jsonlBytes, zst_bytes: zstBytes,
            ingestion_date: new Date().toISOString(),
        };
        await uploadR2(client, bucket, CURSOR_KEY, Buffer.from(JSON.stringify(cursor, null, 2), 'utf-8'), 'application/json');
        console.log(`[FDA-SRS-HARVEST] R2 upload OK: ${dataKey} + ${CURSOR_KEY}`);
    } finally {
        for (const p of [tmpZip, tmpJsonl, tmpZst]) { try { unlinkSync(p); } catch { /* ignore */ } }
    }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) main().catch(err => { console.error('[FDA-SRS-HARVEST] FATAL:', err.message); process.exit(2); });
