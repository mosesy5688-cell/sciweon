/**
 * Harvest History — Sciweon V0.5.2
 *
 * Persistent R2-backed log of stage-1 harvest manifest summaries. Each run
 * writes a single small JSON file at `state/harvest-history/<run_id>.json`
 * with the counts the boundary-health monitor needs (warned / fetched /
 * fetch_failed_count / valid / attempted). The full manifest stays local
 * (it can be large with raw failed_fetches[]); only the summary persists.
 *
 * This file is the durable signal stream behind boundary-health.js — without
 * it, source-health.yml cannot tell whether the last two cycles each saw
 * non-zero WARNings (the "sustained WARN = FAIL" rule from PR #19 deferred
 * A.3, finally addressed here).
 *
 * Failure policy: write is best-effort. A failed history write must NOT
 * crash stage-1 — observability cannot regress the critical harvest path.
 * Caller in stage-1-harvest wraps every call in try/catch + WARN log.
 */

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const HISTORY_PREFIX = 'state/harvest-history';
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

function summarize(manifest, runId, startCid, endCid) {
    const stats = manifest?.stats || {};
    const run = manifest?.run || {};
    return {
        run_id: runId,
        completed_at: new Date().toISOString(),
        range: { start_cid: startCid, end_cid: endCid },
        attempted: Number(stats.attempted) || 0,
        fetched: Number(stats.fetched) || 0,
        valid: Number(stats.valid) || 0,
        warned: Number(stats.warned) || 0,
        fetch_failed_count: Number(stats.fetch_failed_count) || 0,
        validation_mode: typeof run.mode === 'string' ? run.mode : null,
        retry_successes: Array.isArray(manifest?.retry_successes) ? manifest.retry_successes.length : 0,
        retry_failures: Array.isArray(manifest?.retry_failures) ? manifest.retry_failures.length : 0,
    };
}

export async function writeHarvestHistory({ runId, manifest, startCid, endCid }) {
    const client = makeClient();
    const summary = summarize(manifest, runId, startCid, endCid);
    const key = `${HISTORY_PREFIX}/${runId}.json`;
    await client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: JSON.stringify(summary, null, 2),
        ContentType: 'application/json',
    }));
    console.log(`[HARVEST-HISTORY] Written ${key} (warned=${summary.warned}, fetch_failed=${summary.fetch_failed_count})`);
    return summary;
}

export async function listLatestHarvests(n = 2) {
    const client = makeClient();
    const res = await client.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        Prefix: `${HISTORY_PREFIX}/`,
        MaxKeys: 1000,
    }));
    const keys = (res.Contents || [])
        .map(o => o.Key)
        .filter(k => typeof k === 'string' && k.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, n);
    const summaries = [];
    for (const key of keys) {
        try {
            const obj = await client.send(new GetObjectCommand({
                Bucket: process.env.R2_BUCKET,
                Key: key,
            }));
            const buf = await streamToBuffer(obj.Body);
            summaries.push(JSON.parse(buf.toString()));
        } catch (err) {
            console.warn(`[HARVEST-HISTORY] Could not read ${key}: ${err.message}`);
        }
    }
    return summaries;
}
