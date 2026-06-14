/**
 * RK-15 PR-B — candidate compound sample-shard decode probe, extracted from
 * stage-4-activate.js to keep it under the CES Art 5.1 250-line cap.
 *
 * validateCandidate proves the candidate's compound surface is a REAL sharded
 * NXVF family (not just present keys): re-read the compound manifest, resolve a
 * sample shard ref by hash, and decode its header to assert a real NXVF V4.1
 * container with a positive entity count. Throws (fail-loud) on any gate.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { compoundsShardKey } from './snapshot-identity.js';

// NXVF V4.1 container header (shard-writer.js): "NXVF" magic at byte 0 +
// EntityCount (UInt32LE) at byte 11. A sample-shard decode = assert the magic +
// a positive entity count, proving the candidate shard is a real container.
const NXVF_MAGIC = Buffer.from([0x4E, 0x58, 0x56, 0x46]);
function assertNxvfShard(buf) {
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
 * (c)+(d): re-read the compound manifest at `seal.compounds_manifest_key`, assert
 * it declares >=1 shard, resolve the first shard by hash, GET it, and decode its
 * header (assertNxvfShard). Throws on any gate.
 */
export async function probeCompoundSampleShard({ client, bucket, objectPrefix, seal }) {
    const mfRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: seal.compounds_manifest_key }));
    const manifest = JSON.parse((await streamToBuffer(mfRes.Body)).toString('utf-8'));
    if (!Array.isArray(manifest.shard_hashes) || manifest.shard_hashes.length === 0) {
        throw new Error('[ACTIVATE] candidate compound manifest has no shards');
    }
    const sample = manifest.shard_hashes[0];
    const shardKey = compoundsShardKey(objectPrefix, manifest.bucket ?? 0, sample.shard);
    const shRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: shardKey }));
    const shardBuf = await streamToBuffer(shRes.Body);
    try { assertNxvfShard(shardBuf); }
    catch (err) { throw new Error(`[ACTIVATE] candidate sample shard failed to decode: ${shardKey} (${err.message})`); }
}
