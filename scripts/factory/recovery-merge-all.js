/**
 * Cumulative Aggregated Recovery — V0.5.2.1 one-time backfill.
 *
 * Pre-V0.5.2.1 every Sciweon factory cycle replaced the API-visible
 * aggregated bundle. Historical cycles still live at R2 prefixes like
 * `processed/aggregated/<run_id>/` but the `latest.json` pointer has
 * advanced past them. As a result, GET /api/v1/compound/<historical CID>
 * returns 0 records even though the underlying data is still in R2.
 *
 * This script is a ONE-TIME recovery: list all historical aggregated
 * bundles, download each in chronological order, merge them with the
 * same replace-by-id semantics V0.5.2.1 stage-3 uses going forward,
 * upload the merged result as a new run_id, and advance the latest
 * pointer.
 *
 * After this script:
 *   - factory-4-upload.yml manual dispatch rebuilds snapshot from the
 *     fresh cumulative bundle
 *   - API queries for historical CIDs (e.g., 15730) return their data
 *
 * Going forward, V0.5.2.1 stage-3 keeps cumulative state intact each
 * cycle — this recovery is one-shot, not a recurring step.
 *
 * Idempotency: re-running this script will re-merge from scratch and
 * upload a new recovery run_id. Safe to retry.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { mergeRecords, MERGE_FILES, KEY_FN_PER_FILE } from './lib/aggregated-merger.js';

const STAGE_PREFIX = 'processed/aggregated/';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function envReady() {
    return REQUIRED_ENV.every(k => process.env[k]);
}

function makeClient() {
    if (!envReady()) {
        const missing = REQUIRED_ENV.filter(k => !process.env[k]);
        throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    }
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function getObjectBuf(client, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    return streamToBuffer(res.Body);
}

async function listRunIds(client) {
    const runIds = new Set();
    let continuationToken;
    do {
        const res = await client.send(new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET,
            Prefix: STAGE_PREFIX,
            ContinuationToken: continuationToken,
        }));
        for (const obj of res.Contents || []) {
            const k = obj.Key;
            if (!k || !k.startsWith(STAGE_PREFIX)) continue;
            const rest = k.slice(STAGE_PREFIX.length);
            if (rest === 'latest.json') continue;
            const segs = rest.split('/');
            if (segs.length < 2) continue;
            runIds.add(segs[0]);
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return [...runIds].sort();
}

function parseJsonl(buf) {
    if (!buf || buf.length === 0) return [];
    const text = buf.toString('utf-8');
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); }
        catch { /* skip malformed */ }
    }
    return out;
}

function serializeJsonl(records) {
    return records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

async function main() {
    console.log('[RECOVERY] Sciweon Cumulative Aggregated Recovery V0.5.2.1');
    const client = makeClient();

    console.log(`[RECOVERY] Listing all aggregated run_ids under ${STAGE_PREFIX}`);
    const runIds = await listRunIds(client);
    console.log(`[RECOVERY] Found ${runIds.length} historical run_ids: ${runIds.join(', ')}`);
    if (runIds.length === 0) {
        console.log('[RECOVERY] Nothing to recover.');
        return;
    }

    // Accumulator: per file, Map<key, record>. No-key records accumulate
    // in a separate array per file (link files with composite key wraps fine).
    const accumByFile = {};
    const noKeyByFile = {};
    for (const f of MERGE_FILES) { accumByFile[f] = new Map(); noKeyByFile[f] = []; }

    for (const runId of runIds) {
        console.log(`\n[RECOVERY] === Merging run_id=${runId} ===`);
        let totalForRun = 0;
        for (const fname of MERGE_FILES) {
            const key = `${STAGE_PREFIX}${runId}/${fname}`;
            let buf;
            try { buf = await getObjectBuf(client, key); }
            catch (err) {
                if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) continue;
                throw err;
            }
            const records = parseJsonl(buf);
            const keyFn = KEY_FN_PER_FILE[fname];
            const currentAsList = [...accumByFile[fname].values(), ...noKeyByFile[fname]];
            const { merged } = mergeRecords(records, currentAsList, keyFn);
            // Re-bucket: replace accumulator with new merged set
            accumByFile[fname] = new Map();
            noKeyByFile[fname] = [];
            for (const rec of merged) {
                const k = keyFn(rec);
                if (k === null) noKeyByFile[fname].push(rec);
                else accumByFile[fname].set(k, rec);
            }
            totalForRun += records.length;
        }
        console.log(`[RECOVERY]   Loaded ${totalForRun} records from this run_id, accumulator now:`);
        for (const f of MERGE_FILES) {
            console.log(`    ${f.padEnd(35)} total=${accumByFile[f].size + noKeyByFile[f].length}`);
        }
    }

    // Generate recovery run_id (distinct from natural cron run_ids which are pure digits)
    const recoveryRunId = `recovery-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    console.log(`\n[RECOVERY] === Uploading merged bundle as run_id=${recoveryRunId} ===`);
    for (const fname of MERGE_FILES) {
        const records = [...accumByFile[fname].values(), ...noKeyByFile[fname]];
        const body = serializeJsonl(records);
        const key = `${STAGE_PREFIX}${recoveryRunId}/${fname}`;
        await client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
            Body: body,
            ContentType: 'application/jsonl',
        }));
        console.log(`  ${fname.padEnd(35)} ${records.length} records, ${(body.length / 1024).toFixed(1)} KB`);
    }

    // Update latest pointer
    const pointer = {
        stage: 'aggregated',
        run_id: recoveryRunId,
        completed_at: new Date().toISOString(),
        files: MERGE_FILES.length,
        note: `V0.5.2.1 one-time recovery: merged ${runIds.length} historical run_ids`,
    };
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `${STAGE_PREFIX}latest.json`,
        Body: JSON.stringify(pointer, null, 2),
        ContentType: 'application/json',
    }));
    console.log(`\n[RECOVERY] latest.json -> ${recoveryRunId}`);
    console.log('[RECOVERY] Done. Dispatch factory-4-upload.yml to rebuild snapshot.');
}

main().catch(err => { console.error('[RECOVERY] Fatal:', err); process.exit(1); });
