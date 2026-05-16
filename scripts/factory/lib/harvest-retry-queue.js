/**
 * Harvest Retry Queue — Sciweon V0.5.1
 *
 * R2-backed persistent queue of PubChem CIDs whose previous fetch attempt
 * failed transiently (HTTP 5xx / network error / timeout). Stage 1 drains
 * the queue at the start of every run so failed CIDs eventually land in R2
 * even when the upstream PubChem PUG-REST endpoint has brief outages.
 *
 * Pattern is the architectural twin of Free2AITools params-cache.json.zst
 * (PR #1990 root-cause class): persistent cross-cycle R2 state that turns
 * single-point fetch failures into eventually-consistent harvest, without
 * halting the chain on every transient blip.
 *
 * R2 key: state/harvest-retry-queue.json
 *
 * Shape:
 *   {
 *     "entries": [
 *       { "cid": 11741, "first_failed_at": "2026-05-16T00:45:44Z",
 *         "last_attempt_at": "2026-05-16T00:45:44Z",
 *         "retries": 0, "last_error": "fetch failed" },
 *       ...
 *     ],
 *     "last_updated": "2026-05-16T05:30:00Z"
 *   }
 *
 * Bounds (defense-in-depth):
 *   - MAX_QUEUE_DEPTH = 500. Queue larger than this means PubChem is in a
 *     real outage and we must surface — caller checks depth and throws
 *     before advancing cursor so the next cron retries the full window.
 *   - MAX_RETRIES_PER_ENTRY = 10. After 10 unsuccessful retries an entry
 *     is classified as "permanently deprecated CID" (PubChem does retract
 *     duplicate / superseded compounds); pruneExhausted() returns these so
 *     the caller can audit-log them once and remove from the active queue.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const QUEUE_KEY = 'state/harvest-retry-queue.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export const MAX_QUEUE_DEPTH = 500;
export const MAX_RETRIES_PER_ENTRY = 10;

const DEFAULT_QUEUE = { entries: [], last_updated: null };

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

function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cid = Number(raw.cid);
    if (!Number.isInteger(cid) || cid < 1) return null;
    return {
        cid,
        first_failed_at: typeof raw.first_failed_at === 'string' ? raw.first_failed_at : new Date().toISOString(),
        last_attempt_at: typeof raw.last_attempt_at === 'string' ? raw.last_attempt_at : new Date().toISOString(),
        retries: Number.isInteger(raw.retries) && raw.retries >= 0 ? raw.retries : 0,
        last_error: typeof raw.last_error === 'string' ? raw.last_error.slice(0, 200) : '',
    };
}

export async function readQueue() {
    const client = makeClient();
    try {
        const res = await client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: QUEUE_KEY,
        }));
        const buf = await streamToBuffer(res.Body);
        const parsed = JSON.parse(buf.toString());
        const entries = Array.isArray(parsed.entries) ? parsed.entries.map(sanitizeEntry).filter(Boolean) : [];
        const seen = new Set();
        const deduped = [];
        for (const e of entries) {
            if (seen.has(e.cid)) continue;
            seen.add(e.cid);
            deduped.push(e);
        }
        return { entries: deduped, last_updated: parsed.last_updated || null };
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            console.log('[RETRY-QUEUE] No queue in R2 - bootstrapping empty');
            return { ...DEFAULT_QUEUE, entries: [] };
        }
        throw new Error(`Failed to read retry queue: ${err.message}`);
    }
}

export async function writeQueue(queue) {
    const client = makeClient();
    const body = JSON.stringify({
        entries: queue.entries.map(sanitizeEntry).filter(Boolean),
        last_updated: new Date().toISOString(),
    }, null, 2);
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: QUEUE_KEY,
        Body: body,
        ContentType: 'application/json',
    }));
    console.log(`[RETRY-QUEUE] Written: depth=${queue.entries.length}`);
}

/**
 * Merge a fresh batch of fetch failures into the queue.
 * - Existing entry for the same CID: increment retries, refresh last_attempt_at + last_error
 * - New CID: append with retries=0
 * Caller passes successCids (CIDs that succeeded this run, e.g. retry-queue drains
 * that finally worked) so they are removed.
 */
export function mergeFailures(queue, newFailures, successCids = []) {
    const successSet = new Set(successCids.map(Number));
    const failureMap = new Map(newFailures.map(f => [Number(f.cid), f]));
    const now = new Date().toISOString();
    const merged = [];

    for (const existing of queue.entries) {
        if (successSet.has(existing.cid)) continue;
        const refresh = failureMap.get(existing.cid);
        if (refresh) {
            merged.push({
                cid: existing.cid,
                first_failed_at: existing.first_failed_at,
                last_attempt_at: now,
                retries: existing.retries + 1,
                last_error: String(refresh.error || '').slice(0, 200),
            });
            failureMap.delete(existing.cid);
        } else {
            merged.push(existing);
        }
    }

    for (const [cid, f] of failureMap.entries()) {
        merged.push({
            cid,
            first_failed_at: now,
            last_attempt_at: now,
            retries: 0,
            last_error: String(f.error || '').slice(0, 200),
        });
    }

    return { ...queue, entries: merged };
}

/**
 * Split out entries that have exceeded MAX_RETRIES_PER_ENTRY.
 * Caller logs these once and the queue keeps only the active entries.
 */
export function pruneExhausted(queue) {
    const active = [];
    const exhausted = [];
    for (const entry of queue.entries) {
        if (entry.retries >= MAX_RETRIES_PER_ENTRY) exhausted.push(entry);
        else active.push(entry);
    }
    return { active: { ...queue, entries: active }, exhausted };
}
