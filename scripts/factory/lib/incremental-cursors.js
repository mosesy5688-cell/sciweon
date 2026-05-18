/**
 * V0.7 per-source incremental cursor helpers.
 * R2 key: state/incremental-cursors/{source}.json
 * Schema: { sinceToken, status, last_run_at, record_count,
 *           supportsIncremental, last_updated }
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const CURSOR_PREFIX = 'state/incremental-cursors';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export function makeIncrementalR2() {
    if (!REQUIRED_ENV.every(k => process.env[k])) {
        const missing = REQUIRED_ENV.filter(k => !process.env[k]);
        console.warn(`[R2] Not configured (missing: ${missing.join(', ')})`);
        return null;
    }
    return {
        client: new S3Client({
            endpoint: process.env.R2_ENDPOINT,
            region: 'auto',
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        }),
        bucket: process.env.R2_BUCKET,
    };
}

export async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

export async function readIncrementalCursor(client, bucket, source) {
    const key = `${CURSOR_PREFIX}/${source}.json`;
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return JSON.parse((await streamToBuffer(res.Body)).toString('utf-8'));
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw new Error(`readIncrementalCursor(${source}): ${e.message}`);
    }
}

export async function writeIncrementalCursor(client, bucket, source, state) {
    const key = `${CURSOR_PREFIX}/${source}.json`;
    const body = JSON.stringify({ ...state, last_updated: new Date().toISOString() }, null, 2);
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
    }));
}
