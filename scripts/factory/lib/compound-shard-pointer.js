/**
 * Compound Shard Pointer Ops — Wave I-7a Phase 1.
 *
 * Split from compound-shard-publisher.js to keep each file under CES Art 5.1
 * 250-line cap. Logical separation: publisher = data prep; pointer = R2
 * integrity + atomic pointer swap.
 *
 * Two responsibilities:
 *   1. verifyShardIntegrity — Constitution V16.1 §9 mandatory pre-swap check.
 *      Pulls N random shards via GetObject, sha256-compares to manifest.
 *   2. updateLatestPointer — backward-compatible JSON merge into
 *      snapshots/latest.json, adding compounds_manifest_key without
 *      disturbing latest_snapshot_date / manifest_key fields.
 */

import { createHash } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { swapLatestPointer } from './publish-shards-and-swap.js';

function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function pad4(n) { return String(n).padStart(4, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function shardKeyFor(snapshotDate, bucket, shardId) {
    return `snapshots/${snapshotDate}/compounds/bucket-${pad4(bucket)}/shard-${pad3(shardId)}.bin`;
}

export async function verifyShardIntegrity(client, bucket, snapshotDate, manifest, sampleCount = 3) {
    const shards = manifest.shard_hashes;
    if (shards.length === 0) {
        throw new Error('[POINTER] No shards in manifest — refusing to verify');
    }
    const picked = new Set();
    const targets = [];
    const n = Math.min(sampleCount, shards.length);
    while (targets.length < n) {
        const idx = Math.floor(Math.random() * shards.length);
        if (picked.has(idx)) continue;
        picked.add(idx);
        targets.push(shards[idx]);
    }
    for (const t of targets) {
        const key = shardKeyFor(snapshotDate, manifest.bucket, t.shard);
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const c of res.Body) chunks.push(c);
        const observed = sha256(Buffer.concat(chunks));
        if (observed !== t.sha256) {
            throw new Error(`[POINTER] Integrity probe FAILED for ${key}: expected ${t.sha256}, got ${observed}`);
        }
        console.log(`[POINTER] Probe OK: ${key} sha256=${observed.slice(0, 16)}...`);
    }
}

/**
 * Backward-compatible wrapper: now delegates to the shared CAS swapLatestPointer
 * (publish-shards-and-swap.js) so there is ONE pointer-swap path. Sets
 * latest_snapshot_date + compounds_manifest_key + a derivable manifest_key,
 * read-merging the rest. Kept for call-site compatibility; stage-4 now prefers
 * a single terminal swapLatestPointer that merges compound + neg keys at once.
 */
export async function updateLatestPointer(client, bucket, { snapshotDate, compoundsManifestKey }) {
    return swapLatestPointer(
        client, bucket,
        {
            latest_snapshot_date: snapshotDate,
            manifest_key: `snapshots/${snapshotDate}/manifest.json`,
            compounds_manifest_key: compoundsManifestKey,
        },
        ['latest_snapshot_date', 'compounds_manifest_key'],
    );
}
