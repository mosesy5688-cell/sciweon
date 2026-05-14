/**
 * Harvest Cursor V0.5.0
 *
 * R2-backed persistent cursor for incremental harvest. Tracks the next
 * compound CID to fetch so each cron run picks up where the previous one
 * stopped, never re-fetching the same CID range.
 *
 * R2 key: state/harvest-cursor.json
 * Shape:
 *   {
 *     "next_cid": 5001,
 *     "last_run_at": "2026-05-17T02:00:00.000Z",
 *     "last_success_count": 5000,
 *     "total_collected": 5000
 *   }
 *
 * Bootstrap: if the cursor key does not exist, readCursor() returns
 * { next_cid: 1, ... } so first cron run starts from CID 1.
 *
 * Idempotency: writeCursor() is called only after Phase H snapshot upload
 * succeeds. Mid-run failures leave the cursor unchanged so the next run
 * retries the same CID range.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const CURSOR_KEY = 'state/harvest-cursor.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

const DEFAULT_CURSOR = {
    next_cid: 1,
    last_run_at: null,
    last_success_count: 0,
    total_collected: 0,
};

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

export async function readCursor() {
    const client = makeClient();
    try {
        const res = await client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: CURSOR_KEY,
        }));
        const buf = await streamToBuffer(res.Body);
        const cursor = JSON.parse(buf.toString());
        if (typeof cursor.next_cid !== 'number' || cursor.next_cid < 1) {
            throw new Error(`cursor.next_cid invalid: ${cursor.next_cid}`);
        }
        return {
            next_cid: cursor.next_cid,
            last_run_at: cursor.last_run_at || null,
            last_success_count: cursor.last_success_count || 0,
            total_collected: cursor.total_collected || 0,
        };
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            console.log('[CURSOR] No cursor in R2 - bootstrapping with default (next_cid=1)');
            return { ...DEFAULT_CURSOR };
        }
        throw new Error(`Failed to read cursor: ${err.message}`);
    }
}

export async function writeCursor(cursor) {
    if (typeof cursor.next_cid !== 'number' || cursor.next_cid < 1) {
        throw new Error(`Refusing to write invalid cursor.next_cid=${cursor.next_cid}`);
    }
    const client = makeClient();
    const body = JSON.stringify({
        next_cid: cursor.next_cid,
        last_run_at: cursor.last_run_at || new Date().toISOString(),
        last_success_count: cursor.last_success_count || 0,
        total_collected: cursor.total_collected || 0,
    }, null, 2);
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: CURSOR_KEY,
        Body: body,
        ContentType: 'application/json',
    }));
    console.log(`[CURSOR] Written: next_cid=${cursor.next_cid}, total=${cursor.total_collected}`);
}
