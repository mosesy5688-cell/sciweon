/**
 * Open Targets quarterly bulk ingest (cycle 23 PR-OT-3).
 *
 * First Sciweon production use of the parquet-duckdb-bulk pipeline
 * pattern. The workflow's DuckDB step extracts one OT drug_molecule
 * Parquet partition set into a JSONL file on disk; this script reads
 * that file line-by-line, transforms each row to the Sciweon OT-bulk
 * record shape (lib/open-targets-sql.js), zstd-compresses the
 * concatenated JSONL, uploads to R2 at
 *   processed/bulk/open-targets/<release>/drug-molecule.jsonl.zst
 * and writes the cursor JSON at state/open-targets-cursor.json.
 *
 * Scope: drug_molecule table only. PR-OT-3b adds drug_indication +
 * drug_mechanism_of_action + drug_warning + known_drug join into a
 * fuller known_drug_info object (per PR-OT-2 schema contract). PR-OT-4
 * stage-3-aggregate.js consumes the R2 artifact and merges into the
 * compound entity via the ChEMBL ID join key.
 *
 * Usage:
 *   node scripts/factory/open-targets-harvest.js \
 *     --jsonl=/tmp/drug-molecule.jsonl \
 *     --release=26.03 \
 *     [--dry-run]
 *
 * Required env (REJECT mode unless --dry-run):
 *   R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * Exit codes:
 *   0  ingest succeeded (or dry-run completed)
 *   1  any error (missing env, parse failure, R2 upload failure)
 */
import { createReadStream } from 'fs';
import readline from 'readline';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { openTargetsRowToSciweonRecord, buildCursorRecord } from './lib/open-targets-sql.js';
import { zstdCompress } from './lib/zstd-helper.js';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const CURSOR_KEY = 'state/open-targets-cursor.json';

function parseArgs() {
    const args = { jsonl: null, release: null, dryRun: false };
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--jsonl=')) args.jsonl = a.slice('--jsonl='.length);
        else if (a.startsWith('--release=')) args.release = a.slice('--release='.length);
        else if (a === '--dry-run') args.dryRun = true;
    }
    if (!args.jsonl) throw new Error('[OT-INGEST] --jsonl=<path> required');
    if (!args.release) throw new Error('[OT-INGEST] --release=<version> required');
    return args;
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) throw new Error(`[OT-INGEST] missing env: ${missing.join(', ')}`);
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
        records.push(openTargetsRowToSciweonRecord(row, release, ingestionDate));
    }
    if (records.length === 0) {
        throw new Error('[OT-INGEST] zero records parsed; aborting (would emit empty bulk artifact)');
    }
    if (parseErrors > 0) {
        console.warn(`[OT-INGEST] ${parseErrors} JSON parse errors skipped (records emitted: ${records.length})`);
    }
    return records;
}

async function main() {
    const args = parseArgs();
    const ingestedAt = new Date().toISOString();
    const ingestionDate = ingestedAt.slice(0, 10);

    console.log(`[OT-INGEST] release=${args.release} jsonl=${args.jsonl} dry-run=${args.dryRun}`);
    const records = await readAndTransform(args.jsonl, args.release, ingestionDate);
    console.log(`[OT-INGEST] transformed ${records.length} records`);

    const uncompressed = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    const compressed = await zstdCompress(uncompressed, 3);
    const ratio = (compressed.length / uncompressed.length * 100).toFixed(1);
    console.log(`[OT-INGEST] uncompressed=${uncompressed.length}B compressed=${compressed.length}B ratio=${ratio}%`);

    const outputKey = `processed/bulk/open-targets/${args.release}/drug-molecule.jsonl.zst`;
    const cursor = buildCursorRecord({
        release: args.release,
        recordCount: records.length,
        byteSizeUncompressed: uncompressed.length,
        byteSizeCompressed: compressed.length,
        ingestedAt,
    });

    if (args.dryRun) {
        console.log(`[OT-INGEST] DRY-RUN: would PUT ${outputKey} (${compressed.length}B) + ${CURSOR_KEY}`);
        console.log(`[OT-INGEST] cursor preview: ${JSON.stringify(cursor)}`);
        return;
    }

    const s3 = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: outputKey, Body: compressed,
        ContentType: 'application/zstd', ContentEncoding: 'zstd',
    }));
    console.log(`[OT-INGEST] uploaded ${outputKey}`);

    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: CURSOR_KEY,
        Body: Buffer.from(JSON.stringify(cursor, null, 2), 'utf-8'),
        ContentType: 'application/json',
    }));
    console.log(`[OT-INGEST] cursor written ${CURSOR_KEY}`);
    console.log('[OT-INGEST] SUCCESS');
}

main().catch(err => {
    console.error(`[OT-INGEST] FAILED: ${err.message}`);
    process.exit(1);
});
