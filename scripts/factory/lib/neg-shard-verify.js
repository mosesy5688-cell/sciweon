/**
 * NegEvidence shard integrity verifier — Constitution V16.1 §9 pre-swap probe
 * for the neg shards. Re-fetches N random (bucket, shard) pairs from R2 and
 * sha256-compares to the manifests' shard_hashes. Refuses the swap on mismatch.
 *
 * Unlike the compound verifier (single bucket-0000), neg shards span many
 * buckets, so we sample across the FLAT list of (bucket, shard, sha256) pairs.
 */

import { createHash } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
function pad4(n) { return String(n).padStart(4, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function negShardKey(date, bucket, shard) {
    return `snapshots/${date}/neg-evidence/bucket-${pad4(bucket)}/shard-${pad3(shard)}.bin`;
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

/**
 * @param manifests Array of per-bucket manifests (each has .bucket +
 *   .shard_hashes:[{shard, sha256}]).
 */
export async function verifyNegShardIntegrity(client, bucket, snapshotDate, manifests, sampleCount = 3) {
    const flat = [];
    for (const m of manifests) {
        for (const h of m.shard_hashes ?? []) {
            flat.push({ bucket: m.bucket, shard: h.shard, sha256: h.sha256 });
        }
    }
    if (flat.length === 0) {
        throw new Error('[NEG-POINTER] No neg shards in any manifest — refusing to verify');
    }
    const picked = new Set();
    const n = Math.min(sampleCount, flat.length);
    const targets = [];
    while (targets.length < n) {
        const idx = Math.floor(Math.random() * flat.length);
        if (picked.has(idx)) continue;
        picked.add(idx);
        targets.push(flat[idx]);
    }
    for (const t of targets) {
        const key = negShardKey(snapshotDate, t.bucket, t.shard);
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const observed = sha256(await streamToBuffer(res.Body));
        if (observed !== t.sha256) {
            throw new Error(`[NEG-POINTER] Integrity probe FAILED for ${key}: expected ${t.sha256}, got ${observed}`);
        }
        console.log(`[NEG-POINTER] Probe OK: ${key} sha256=${observed.slice(0, 16)}...`);
    }
}
