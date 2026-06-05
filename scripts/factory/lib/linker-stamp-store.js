/**
 * Linker query-stamp store (PR-B coverage-ceiling) -- R2-backed freshness state.
 *
 * The trial/paper coverage cursor needs a per-compound "last queried at" stamp
 * that PERSISTS ACROSS RUNS so skip-if-fresh can advance the cursor through new
 * / stale compounds. We store this state in R2 `state/` -- the SAME round-trip
 * channel as the enrichment cursor (state/enrichment-cursor/<source>.json) --
 * NOT in the aggregated bundle, deliberately:
 *
 *   - The F3 linkers run BEFORE the cumulative merge, so a stamp written into
 *     the aggregated bundle this run would not be visible to the linker until
 *     the NEXT run's merge -- a read-after-write gap that breaks freshness.
 *     Reading/writing R2 state directly (like the cursor) closes that gap.
 *   - AGGREGATED_FILES additions hard-fail uploadStage if a producer ever skips
 *     the file, and would auto-leak into the public SNAPSHOT_FILES projection
 *     unless explicitly omitted. R2 `state/` carries neither hazard.
 *
 * Shape: one JSONL object per stamped compound: {compound_id, queried_at} where
 * queried_at is an ISO-8601 string. Network/IO failures BUBBLE UP (no silent
 * swallow per [[cross_cycle_silent_data_loss]]); a 404 (no stamps yet) is the
 * only legitimate empty and resolves to an empty Map.
 *
 * Mirrors lib/enrichment-cursor.js's R2 client + read/write conventions exactly.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function stampKey(source) {
    return `state/linker-query-stamps/${source}.jsonl`;
}

function makeR2Client() {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length > 0) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
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

/**
 * Parse the JSONL stamp body into a Map: compound_id -> queried_at ISO string.
 * Pure (no I/O) so it is unit-testable without R2. A malformed line THROWS (no
 * silent skip) -- mirrors loadJsonlStrict's halt-loud semantics.
 */
export function parseStamps(text) {
    const map = new Map();
    if (!text) return map;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const rec = JSON.parse(t); // throws on malformed -> halt loud
        if (rec && typeof rec.compound_id === 'string' && typeof rec.queried_at === 'string') {
            map.set(rec.compound_id, rec.queried_at);
        }
    }
    return map;
}

/**
 * Serialize a stamps Map back to deterministic JSONL (sorted by compound_id so
 * the byte output is stable across runs on identical state -- GEMINI.md Sec 7).
 */
export function serializeStamps(map) {
    return [...map.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([compound_id, queried_at]) => JSON.stringify({ compound_id, queried_at }))
        .join('\n') + (map.size > 0 ? '\n' : '');
}

/**
 * Read the prior stamps for `source` from R2. Returns a Map (empty on first run
 * / 404). Real IO errors bubble up.
 */
export async function readStamps(source) {
    const client = makeR2Client();
    try {
        const res = await client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: stampKey(source),
        }));
        const buf = await streamToBuffer(res.Body);
        return parseStamps(buf.toString('utf-8'));
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return new Map();
        }
        throw err;
    }
}

/** Write the full stamps Map for `source` back to R2. */
export async function writeStamps(source, map) {
    const client = makeR2Client();
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: stampKey(source),
        Body: serializeStamps(map),
        ContentType: 'application/x-ndjson',
    }));
}
