/**
 * RK-15 PR-B / RK-16A0 — candidate sample-shard decode probe, extracted from
 * stage-4-activate.js to keep it under the CES Art 5.1 250-line cap.
 *
 * validateCandidate proves a candidate's sharded surface is a REAL sharded NXVF
 * family (not just present keys): re-read the per-bucket manifest, resolve a
 * sample shard ref by hash, and decode its header to assert a real NXVF V4.1
 * container with a positive entity count. Throws (fail-loud) on any gate.
 *
 * RK-16A0 generalizes the original compound-only probe into `probeSampleShard`,
 * parameterized by manifest key + shard-key deriver, so the structured-inventory
 * gate can re-use it for EVERY sharded family (compounds + neg-evidence). The
 * historical `probeCompoundSampleShard` is kept as a thin back-compat wrapper.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { compoundsShardKey } from './snapshot-identity.js';

// NXVF V4.1 container header (shard-writer.js): "NXVF" magic at byte 0 +
// EntityCount (UInt32LE) at byte 11. A sample-shard decode = assert the magic +
// a positive entity count, proving the candidate shard is a real container.
const NXVF_MAGIC = Buffer.from([0x4E, 0x58, 0x56, 0x46]);
export function assertNxvfShard(buf) {
    if (buf.length < 29 || !buf.subarray(0, 4).equals(NXVF_MAGIC)) {
        throw new Error('not an NXVF container (bad magic / too short)');
    }
    const entityCount = buf.readUInt32LE(11);
    if (entityCount <= 0) throw new Error('NXVF container declares zero entities');
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

/**
 * GENERIC sharded-family sample probe (RK-16A0): GET the per-bucket manifest at
 * `manifestKey`, assert it declares >=1 shard, resolve the first shard by hash
 * via `deriveShard(objectPrefix, manifest.bucket ?? 0, shard)`, GET it, and decode
 * its header (assertNxvfShard). Throws (fail-loud) on any gate; every error names
 * the offending key. Both compounds AND neg-evidence per-bucket manifests expose
 * the same `shard_hashes: [{shard,...}]` + `bucket` shape, so ONE probe fits both.
 */
export async function probeSampleShard({ client, bucket, objectPrefix, manifestKey, deriveShard }) {
    let manifest;
    try {
        const mfRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }));
        manifest = JSON.parse((await streamToBuffer(mfRes.Body)).toString('utf-8'));
    } catch (err) {
        throw new Error(`[ACTIVATE] structured manifest missing or unreadable: ${manifestKey} (${err.message})`);
    }
    if (!Array.isArray(manifest.shard_hashes) || manifest.shard_hashes.length === 0) {
        throw new Error(`[ACTIVATE] structured manifest has no shards: ${manifestKey}`);
    }
    const sample = manifest.shard_hashes[0];
    const shardKey = deriveShard(objectPrefix, manifest.bucket ?? 0, sample.shard);
    let shardBuf;
    try {
        const shRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: shardKey }));
        shardBuf = await streamToBuffer(shRes.Body);
    } catch (err) {
        throw new Error(`[ACTIVATE] structured sample shard missing: ${shardKey} (${err.message})`);
    }
    try { assertNxvfShard(shardBuf); }
    catch (err) { throw new Error(`[ACTIVATE] structured sample shard failed to decode: ${shardKey} (${err.message})`); }
}

/**
 * (c)+(d) back-compat wrapper: probe the candidate's COMPOUND family at
 * `seal.compounds_manifest_key` using the compound shard-key deriver. Behaviour
 * preserved for the existing validateCandidate compound step + its tests.
 */
export async function probeCompoundSampleShard({ client, bucket, objectPrefix, seal }) {
    await probeSampleShard({
        client, bucket, objectPrefix,
        manifestKey: seal.compounds_manifest_key,
        deriveShard: compoundsShardKey,
    });
}
