/**
 * Bulk shard helpers — R2 client, compression, naming, per-worker manifest upload.
 * Used by bulk-pubchem-shard.js (B.3).
 */

import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export function makeR2Client() {
    if (!REQUIRED_ENV.every(k => process.env[k])) {
        const missing = REQUIRED_ENV.filter(k => !process.env[k]);
        return { client: null, bucket: null, missing };
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
        missing: [],
    };
}

export function sha256hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// shard-cid-000000001-000001000.jsonl.gz
export function buildShardKey(prefix, minCid, maxCid) {
    const pad = n => String(n).padStart(9, '0');
    const id = `shard-cid-${pad(minCid)}-${pad(maxCid)}`;
    return {
        id,
        r2Key: `${prefix}/shards/${id}.jsonl.gz`,
    };
}

export function compressBuf(raw) {
    return gzipSync(raw, { level: 9 });
}

export async function uploadBuf(client, bucket, key, buf, contentType) {
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buf,
        ContentType: contentType,
    }));
}

export async function uploadWorkerManifest(client, bucket, prefix, workerShard, manifest) {
    const key = `${prefix}/workers/worker-${workerShard}.json`;
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json',
    }));
    return key;
}

export async function downloadWorkerManifest(client, bucket, prefix, workerShard) {
    const key = `${prefix}/workers/worker-${workerShard}.json`;
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of res.Body) chunks.push(chunk);
        return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch (e) {
        console.warn(`[SHARD] worker-${workerShard} manifest not found in R2: ${e.message}`);
        return null;
    }
}

export async function uploadGlobalIndex(client, bucket, prefix, indexData) {
    const key = `${prefix}/index.json`;
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(indexData, null, 2),
        ContentType: 'application/json',
    }));
    return key;
}
