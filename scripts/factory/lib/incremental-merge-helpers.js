/**
 * V0.7 fan-in merge helpers: zero-delta detection, staging delta I/O,
 * previous cumulative load, aggregated upload, staging cleanup.
 */

import { gzipSync, gunzipSync } from 'zlib';
import {
    GetObjectCommand, PutObjectCommand,
    ListObjectsV2Command, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { streamToBuffer } from './incremental-cursors.js';

const STAGING_PREFIX  = 'staging/incremental';
const AGGREGATED_PREFIX = 'processed/aggregated';

// Returns number of staging files for this runId (>0 means real data exists).
export async function detectZeroDeltas(client, bucket, runId) {
    let count = 0;
    let token;
    do {
        const res = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${STAGING_PREFIX}/`,
            ContinuationToken: token,
        }));
        for (const obj of (res.Contents ?? [])) {
            if (obj.Key.includes(`/${runId}/`) && obj.Size > 50) count++;
        }
        token = res.NextContinuationToken;
    } while (token);
    return count;
}

// Returns parsed records array or null if no staging delta for this source/run.
export async function loadStagingDelta(client, bucket, source, runId) {
    const key = `${STAGING_PREFIX}/${source}/${runId}/${source}.jsonl.gz`;
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const gz = await streamToBuffer(res.Body);
        return gunzipSync(gz).toString('utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw new Error(`loadStagingDelta(${source}): ${e.message}`);
    }
}

// Load previous cumulative from latest.json pointer. Returns Map<id, entity>.
export async function loadPreviousAggregated(client, bucket) {
    try {
        const ptrRes = await client.send(new GetObjectCommand({
            Bucket: bucket, Key: `${AGGREGATED_PREFIX}/latest.json`,
        }));
        const ptr = JSON.parse((await streamToBuffer(ptrRes.Body)).toString('utf-8'));
        const dataRes = await client.send(new GetObjectCommand({
            Bucket: bucket, Key: `${AGGREGATED_PREFIX}/${ptr.pointer}/all-records.jsonl.gz`,
        }));
        const raw = gunzipSync(await streamToBuffer(dataRes.Body)).toString('utf-8');
        const map = new Map();
        for (const line of raw.split('\n').filter(Boolean)) {
            const r = JSON.parse(line);
            if (r.id) map.set(r.id, r);
        }
        console.log(`[MERGE] Previous cumulative loaded: ${map.size} entities (pointer=${ptr.pointer})`);
        return map;
    } catch {
        console.log('[MERGE] No previous cumulative — starting fresh');
        return new Map();
    }
}

// Upload merged aggregated + meta, then advance latest.json pointer.
export async function uploadAggregated(client, bucket, runId, records, meta) {
    const raw = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const gz = gzipSync(raw, { level: 9 });
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${AGGREGATED_PREFIX}/${runId}/all-records.jsonl.gz`,
        Body: gz,
        ContentType: 'application/gzip',
    }));
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${AGGREGATED_PREFIX}/${runId}/meta.json`,
        Body: JSON.stringify(meta, null, 2),
        ContentType: 'application/json',
    }));
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${AGGREGATED_PREFIX}/latest.json`,
        Body: JSON.stringify({ pointer: runId, timestamp: new Date().toISOString() }),
        ContentType: 'application/json',
    }));
}

// Delete this runId's staging files. Non-fatal if objects already gone.
export async function cleanupStaging(client, bucket, runId) {
    let token;
    do {
        const res = await client.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: `${STAGING_PREFIX}/`, ContinuationToken: token,
        }));
        for (const obj of (res.Contents ?? [])) {
            if (obj.Key.includes(`/${runId}/`)) {
                await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
            }
        }
        token = res.NextContinuationToken;
    } while (token);
}
