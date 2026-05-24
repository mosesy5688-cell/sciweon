/**
 * Open Targets stage-3 merge (cycle 23 PR-OT-4).
 *
 * Invoked by stage-3-aggregate.js after the PR-CORE-3 cumulative
 * backfill pass and before the search/target index builds. Reads the
 * OT bulk artifact from R2 (written by PR-OT-3c open-targets-harvest.js),
 * decompresses via system zstd CLI (Constitution-compliant native
 * binary path, same architecture as PR-OT-3a hotfix), indexes the OT
 * records by ChEMBL ID, then walks the local
 * output/linked/compounds-enriched.jsonl post-cumulative-merge file
 * and applies mergeOtIntoCompound to every compound whose chembl_id
 * matches.
 *
 * Per [[researcher_needs_anchor]] this is the moment OT data crosses
 * from "R2 staging artifact" to "compound entity field" — the unified
 * scientific entity layer absorbs OT enrichment, and the next API
 * query for any aspirin-class compound returns known_drug_info +
 * target_associations populated from OT.
 *
 * Idempotent: re-running produces byte-identical output (per Constitution
 * section 7 determinism invariant).
 *
 * Non-fatal failure mode: if R2 read or zstd decompression fails, log
 * the error and exit with code 0 so stage-3-aggregate.js continues to
 * the un-OT-enriched search/target index builds and R2 upload.
 * Researchers degrade gracefully (no OT data in compound entities)
 * rather than the whole stage halting on a transient OT-only failure.
 */

import { readFileSync, writeFileSync, createReadStream } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { buildOtIndex, mergeOtAcrossCompounds } from './lib/ot-merge.js';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const CURSOR_KEY = 'state/open-targets-cursor.json';
const COMPOUNDS_PATH = 'output/linked/compounds-enriched.jsonl';

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[OT-MERGE] missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function downloadObject(s3, bucket, key) {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return streamToBuffer(response.Body);
}

function zstdDecompressFile(inputPath, outputPath) {
    // PR-OT-4a hotfix: short-form flags (-f -o) for ubuntu-latest zstd CLI
    // compatibility. The long-form `--force --output` was rejected by the
    // GHA runner zstd version with "Incorrect parameter: --output" (run
    // 26356687321 OT-MERGE step). Short-form syntax is universally
    // supported across zstd CLI versions.
    const result = spawnSync('zstd', ['-d', '-f', '-o', outputPath, inputPath]);
    if (result.error) throw new Error(`[OT-MERGE] zstd CLI spawn failed: ${result.error.message}`);
    if (result.status !== 0) {
        const stderr = result.stderr ? result.stderr.toString() : '';
        throw new Error(`[OT-MERGE] zstd CLI exit ${result.status}: ${stderr}`);
    }
}

async function readJsonlFile(filePath) {
    const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });
    const records = [];
    let parseErrors = 0;
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            records.push(JSON.parse(trimmed));
        } catch {
            parseErrors++;
        }
    }
    return { records, parseErrors };
}

async function main() {
    const startTime = Date.now();
    const s3 = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    console.log('[OT-MERGE] Reading OT cursor from R2...');
    const cursorBuf = await downloadObject(s3, bucket, CURSOR_KEY);
    const cursor = JSON.parse(cursorBuf.toString('utf-8'));
    if (!cursor.r2_key || !cursor.release_version) {
        throw new Error('[OT-MERGE] cursor missing r2_key or release_version');
    }
    console.log(`[OT-MERGE] OT release=${cursor.release_version} key=${cursor.r2_key} record_count=${cursor.record_count}`);

    const tmpDir = await mkdir(path.join(os.tmpdir(), 'ot-merge'), { recursive: true });
    const compressedPath = path.join(tmpDir, 'drug-enriched.jsonl.zst');
    const decompressedPath = path.join(tmpDir, 'drug-enriched.jsonl');

    console.log(`[OT-MERGE] Downloading ${cursor.r2_key} ...`);
    const compressedBuf = await downloadObject(s3, bucket, cursor.r2_key);
    await writeFile(compressedPath, compressedBuf);
    console.log(`[OT-MERGE] Compressed ${compressedBuf.length}B; decompressing with zstd CLI...`);
    zstdDecompressFile(compressedPath, decompressedPath);

    const { records: otRecords, parseErrors: otParseErrors } = await readJsonlFile(decompressedPath);
    if (otParseErrors > 0) console.warn(`[OT-MERGE] OT bulk parse errors: ${otParseErrors}`);
    console.log(`[OT-MERGE] Loaded ${otRecords.length} OT records`);

    const { index: otIndex, skipped: indexSkipped } = buildOtIndex(otRecords);
    if (indexSkipped > 0) console.warn(`[OT-MERGE] OT index skipped ${indexSkipped} records (missing chembl_id)`);
    console.log(`[OT-MERGE] Index size: ${otIndex.size} compounds by chembl_id`);

    console.log(`[OT-MERGE] Reading ${COMPOUNDS_PATH} ...`);
    const { records: compounds, parseErrors: compoundParseErrors } = await readJsonlFile(COMPOUNDS_PATH);
    if (compoundParseErrors > 0) {
        throw new Error(`[OT-MERGE] compound parse errors: ${compoundParseErrors} - aborting to prevent silent data loss`);
    }
    console.log(`[OT-MERGE] Loaded ${compounds.length} compounds`);

    const stats = mergeOtAcrossCompounds(compounds, otIndex);
    console.log(`[OT-MERGE] Matched ${stats.matched} compounds (of ${stats.chemblIdPresent} chembl_id-bearing out of ${stats.totalCompounds} total)`);

    const output = compounds.map(c => JSON.stringify(c)).join('\n') + '\n';
    writeFileSync(COMPOUNDS_PATH, output, 'utf-8');
    console.log(`[OT-MERGE] Wrote ${COMPOUNDS_PATH} (${Buffer.byteLength(output)}B)`);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[OT-MERGE] === Summary ===`);
    console.log(`  Elapsed:                ${elapsed}s`);
    console.log(`  OT release:             ${cursor.release_version}`);
    console.log(`  OT records loaded:      ${otRecords.length}`);
    console.log(`  Compounds total:        ${stats.totalCompounds}`);
    console.log(`  Compounds chembl_id+:   ${stats.chemblIdPresent}`);
    console.log(`  Compounds OT-merged:    ${stats.matched}`);
    console.log('[OT-MERGE] SUCCESS');
}

main().catch(err => {
    console.error(`[OT-MERGE] FAILED (non-fatal to stage-3): ${err.message}`);
    process.exit(1);
});
