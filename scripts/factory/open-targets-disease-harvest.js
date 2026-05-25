/**
 * Open Targets disease ingest (cycle 23 PR-SID-1.6b-pre.1a).
 *
 * Mirrors scripts/factory/open-targets-target-harvest.js pattern but for the
 * OT `disease` table. Reads /tmp/disease-enriched.jsonl line-by-line (produced
 * by scripts/factory/sql/open-targets-disease.sql DuckDB extract), transforms
 * each row via openTargetsDiseaseRowToSciweonRecord, zstd-compresses
 * concatenated JSONL, uploads to R2 at
 *   processed/bulk/open-targets/<release>/disease-enriched.jsonl.zst
 * and writes the disease-specific cursor JSON at
 *   state/open-targets-disease-cursor.json
 *
 * Cursor independence: drug-side cursor (state/open-targets-cursor.json),
 * target cursor (state/open-targets-target-cursor.json), and disease cursor
 * are independent — different schema_version, different r2_key — so PR-SID-
 * 1.6b stamping can verify disease freshness independently of drug/target
 * ingest cadence.
 *
 * Usage:
 *   node scripts/factory/open-targets-disease-harvest.js \
 *     --jsonl=/tmp/disease-enriched.jsonl \
 *     --release=26.03 \
 *     [--dry-run]
 *
 * Exit 0 on success / dry-run; exit 1 on any error.
 */
import { createReadStream } from 'fs';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
    openTargetsDiseaseRowToSciweonRecord, buildDiseaseCursorRecord,
} from './lib/open-targets-disease-sql.js';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const CURSOR_KEY = 'state/open-targets-disease-cursor.json';

function zstdCliCompress(input, level = 3) {
    const result = spawnSync('zstd', [`-${level}`, '--stdout', '--quiet'], {
        input, maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) throw new Error(`[OT-DISEASE-INGEST] zstd CLI spawn failed: ${result.error.message}`);
    if (result.status !== 0) {
        const stderr = result.stderr ? result.stderr.toString() : '';
        throw new Error(`[OT-DISEASE-INGEST] zstd CLI exit ${result.status}: ${stderr}`);
    }
    return result.stdout;
}

function parseArgs() {
    const args = { jsonl: null, release: null, dryRun: false };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--jsonl=')) args.jsonl = a.slice('--jsonl='.length);
        else if (a.startsWith('--release=')) args.release = a.slice('--release='.length);
        else if (a === '--dry-run') args.dryRun = true;
    }
    if (!args.jsonl) throw new Error('[OT-DISEASE-INGEST] --jsonl=<path> required');
    if (!args.release) throw new Error('[OT-DISEASE-INGEST] --release=<version> required');
    return args;
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[OT-DISEASE-INGEST] missing env: ${missing.join(', ')}`);
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function readAndTransform(jsonlPath, release, ingestionDate) {
    const rl = readline.createInterface({
        input: createReadStream(jsonlPath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });
    const records = [];
    let parseErrors = 0;
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row;
        try { row = JSON.parse(trimmed); } catch { parseErrors++; continue; }
        records.push(openTargetsDiseaseRowToSciweonRecord(row, release, ingestionDate));
    }
    if (records.length === 0) {
        throw new Error('[OT-DISEASE-INGEST] zero records parsed; aborting (would emit empty bulk artifact)');
    }
    if (parseErrors > 0) {
        console.warn(`[OT-DISEASE-INGEST] ${parseErrors} JSON parse errors skipped`);
    }
    return records;
}

async function main() {
    const args = parseArgs();
    const ingestedAt = new Date().toISOString();
    const ingestionDate = ingestedAt.slice(0, 10);
    console.log(`[OT-DISEASE-INGEST] release=${args.release} jsonl=${args.jsonl} dry-run=${args.dryRun}`);

    const records = await readAndTransform(args.jsonl, args.release, ingestionDate);
    console.log(`[OT-DISEASE-INGEST] transformed ${records.length} disease records`);

    // Defect-15 lesson applied: for-loop concat over JSON.stringify().join('\n') is fine here
    // because records.map already allocates an array of strings — the JS engine handles
    // join() internally without spread-push. join() does NOT use spread on the call stack.
    const uncompressed = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const compressed = zstdCliCompress(uncompressed, 3);
    const ratio = (compressed.length / uncompressed.length * 100).toFixed(1);
    console.log(`[OT-DISEASE-INGEST] uncompressed=${uncompressed.length}B compressed=${compressed.length}B ratio=${ratio}%`);

    const outputKey = `processed/bulk/open-targets/${args.release}/disease-enriched.jsonl.zst`;
    const cursor = buildDiseaseCursorRecord({
        release: args.release, recordCount: records.length,
        byteSizeUncompressed: uncompressed.length, byteSizeCompressed: compressed.length,
        ingestedAt,
    });

    if (args.dryRun) {
        console.log(`[OT-DISEASE-INGEST] DRY-RUN: would PUT ${outputKey} (${compressed.length}B) + ${CURSOR_KEY}`);
        console.log(`[OT-DISEASE-INGEST] cursor preview: ${JSON.stringify(cursor)}`);
        return;
    }

    const s3 = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: outputKey, Body: compressed,
        ContentType: 'application/zstd', ContentEncoding: 'zstd',
    }));
    console.log(`[OT-DISEASE-INGEST] uploaded ${outputKey}`);

    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: CURSOR_KEY,
        Body: Buffer.from(JSON.stringify(cursor, null, 2), 'utf-8'),
        ContentType: 'application/json',
    }));
    console.log(`[OT-DISEASE-INGEST] cursor written ${CURSOR_KEY}`);
    console.log('[OT-DISEASE-INGEST] SUCCESS');
}

main().catch(err => {
    console.error(`[OT-DISEASE-INGEST] FAILED: ${err.message}`);
    process.exit(1);
});
