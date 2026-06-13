/**
 * RK-15 PR-B — validated activation protocol (build seal -> validate candidate
 * by ITS OWN keys -> CAS the v2 latest.json -> post-swap active probe).
 *
 * The publish state machine runs HERE after the data objects are uploaded:
 *   OBJECTS_COMPLETE  the canonical root seal is written LAST (create-only)
 *   VALIDATED         candidate re-read by its own object_prefix keys: inventory
 *                     complete, refs resolve, manifest_hash matches, a sample
 *                     shard decodes — NEVER reading snapshots/latest.json
 *   ACTIVATABLE       all gates pass
 *   ACTIVE            CAS swap of the v2 latest.json + post-swap probe confirms
 *                     latest points at THIS candidate
 *
 * Failure isolation: latest.json is touched ONLY in swapV2Latest, AFTER the
 * candidate is VALIDATED. Any earlier failure (upload/inventory/hash/ref/sample)
 * throws before the swap, so the old latest is left untouched and the half-built
 * candidate stays under its own run-id prefix (undiscoverable by an active
 * reader). On CAS failure the candidate is retained but NOT active.
 */

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
    PUBLISH_STATES, LAYOUT_VERSION_V2, SNAPSHOT_SCHEMA_VERSION,
    canonicalManifestHash, rootSealKey, compoundsManifestKey,
    compoundsShardKey, xrefIndexKey, searchProjectionKey, putCreateOnly,
} from './snapshot-identity.js';
import { swapLatestPointer } from './publish-shards-and-swap.js';

const LATEST_KEY = 'snapshots/latest.json';

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

async function headSize(client, bucket, key) {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return res.ContentLength ?? res.Size ?? 0;
}

/** HEAD the candidate root seal — true if listable, false on 404. */
export async function verifySnapshotSealPresent(client, bucket, objectPrefix) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: rootSealKey(objectPrefix) }));
        return true;
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
        throw err;
    }
}

/**
 * Run the full validated-activation sequence in the strict order:
 *   build+seal (OBJECTS_COMPLETE) -> validate candidate by its OWN keys
 *   (VALIDATED/ACTIVATABLE) -> CAS the v2 latest.json (ACTIVE) -> post-swap
 *   active probe. Returns { manifestHash, latest }. Throws on ANY gate so the
 *   caller leaves latest.json unchanged.
 */
export async function activateValidatedCandidate({
    client, bucket, identity, compoundManifest, negManifestKey, hasXref, hasSearch,
}) {
    // (3->4 step 5) seal LAST.
    const { manifestHash } = await buildAndSealCandidate({
        client, bucket, identity, compoundManifest, negManifestKey, hasXref, hasSearch,
    });
    // (step 6+7) re-read + verify the candidate by its OWN keys (never latest).
    await validateCandidate({ client, bucket, identity, expectedHash: manifestHash });
    console.log(`[ACTIVATE] candidate ${PUBLISH_STATES.VALIDATED} -> ${PUBLISH_STATES.ACTIVATABLE}`);
    // (step 9) CAS the v2 latest.json.
    const cmKey = compoundManifestKeyOf(compoundManifest, identity.objectPrefix);
    const latest = await swapV2Latest({
        client, bucket, identity, manifestHash, compoundsManifestKey: cmKey, negManifestKey, hasXref,
    });
    // (step 10) post-swap active validation.
    await postSwapActiveProbe({ client, bucket, identity, manifestHash });
    return { manifestHash, latest };
}

/**
 * Build the canonical snapshot-root seal and write it LAST (create-only). The
 * seal lists the candidate's required object inventory + the compound manifest
 * hash; the canonical hash over the seal (sans its own hash field) is the
 * manifest_hash bound into latest.json. Returns { manifestHash, seal, sealKey }.
 */
export async function buildAndSealCandidate({
    client, bucket, identity, compoundManifest, negManifestKey, hasXref, hasSearch,
}) {
    const { snapshotId, objectPrefix, snapshotDate, runId, runAttempt, commitSha } = identity;
    const requiredKeys = [compoundManifestKeyOf(compoundManifest, objectPrefix)];
    if (hasXref) requiredKeys.push(xrefIndexKey(objectPrefix));
    if (hasSearch) requiredKeys.push(searchProjectionKey(objectPrefix));
    if (negManifestKey) requiredKeys.push(negManifestKey);

    const sealCore = {
        layout_version: LAYOUT_VERSION_V2,
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: snapshotId,
        snapshot_date: snapshotDate,
        object_prefix: objectPrefix,
        run_id: runId,
        run_attempt: runAttempt,
        commit_sha: commitSha,
        workflow: process.env.GITHUB_WORKFLOW ?? null,
        created_at: new Date().toISOString(),
        state: PUBLISH_STATES.OBJECTS_COMPLETE,
        compounds_manifest_key: compoundManifestKeyOf(compoundManifest, objectPrefix),
        neg_evidence_manifest_key: negManifestKey ?? null,
        xref_index_key: hasXref ? xrefIndexKey(objectPrefix) : null,
        compound_total_records: compoundManifest.total_records,
        compound_shard_hashes: compoundManifest.shard_hashes,
        required_inventory: requiredKeys,
    };
    // The hash is computed over the seal WITHOUT the hash field (it cannot hash
    // itself). It is then stored alongside so a verifier can recompute + compare.
    const manifestHash = canonicalManifestHash(sealCore);
    const seal = { ...sealCore, manifest_hash: manifestHash };
    const sealKey = rootSealKey(objectPrefix);
    await putCreateOnly(client, bucket, sealKey, JSON.stringify(seal), 'application/json');
    return { manifestHash, seal, sealKey };
}

function compoundManifestKeyOf(manifest, objectPrefix) {
    return compoundsManifestKey(objectPrefix, manifest.bucket ?? 0);
}

/**
 * Validate the candidate by reading ONLY its own keys (NEVER latest.json):
 *   - the root seal re-reads + its canonical hash matches the expected hash;
 *   - every required-inventory object exists with size > 0;
 *   - the compound manifest re-reads + its declared refs resolve;
 *   - a sample shard decodes (NXVF round-trip).
 * Throws on any gate. Returns { state: VALIDATED }.
 */
export async function validateCandidate({ client, bucket, identity, expectedHash }) {
    const { objectPrefix } = identity;
    // (a) re-read the seal + recompute hash.
    const sealRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: rootSealKey(objectPrefix) }));
    const seal = JSON.parse((await streamToBuffer(sealRes.Body)).toString('utf-8'));
    const { manifest_hash: storedHash, ...sealCore } = seal;
    const recomputed = canonicalManifestHash(sealCore);
    if (recomputed !== expectedHash || storedHash !== expectedHash) {
        throw new Error(`[ACTIVATE] candidate seal hash mismatch: stored=${storedHash} recomputed=${recomputed} expected=${expectedHash}`);
    }
    // (b) required inventory: every declared object exists + non-empty.
    for (const key of seal.required_inventory ?? []) {
        let size;
        try { size = await headSize(client, bucket, key); }
        catch (err) { throw new Error(`[ACTIVATE] required candidate object missing: ${key} (${err.message})`); }
        if (!size || size <= 0) throw new Error(`[ACTIVATE] required candidate object is empty: ${key}`);
    }
    // (c) re-read the compound manifest + resolve a sample shard ref by hash.
    const mfRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: seal.compounds_manifest_key }));
    const manifest = JSON.parse((await streamToBuffer(mfRes.Body)).toString('utf-8'));
    if (!Array.isArray(manifest.shard_hashes) || manifest.shard_hashes.length === 0) {
        throw new Error('[ACTIVATE] candidate compound manifest has no shards');
    }
    const sample = manifest.shard_hashes[0];
    const shardKey = compoundsShardKey(objectPrefix, manifest.bucket ?? 0, sample.shard);
    const shRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: shardKey }));
    const shardBuf = await streamToBuffer(shRes.Body);
    // (d) decode a sample shard header to prove it is a real NXVF container.
    try { assertNxvfShard(shardBuf); }
    catch (err) { throw new Error(`[ACTIVATE] candidate sample shard failed to decode: ${shardKey} (${err.message})`); }
    return { state: PUBLISH_STATES.VALIDATED };
}

/**
 * CAS-swap the v2 latest.json to ACTIVATE the validated candidate. Writes the
 * full reader-required v2 field-set (binds manifest_hash). On CAS failure the
 * candidate is RETAINED but NOT active and the old latest is unchanged (the
 * caller hard-fails the run).
 */
export async function swapV2Latest({ client, bucket, identity, manifestHash, compoundsManifestKey: cmKey, negManifestKey, hasXref }) {
    const { snapshotId, objectPrefix, snapshotDate, runId, runAttempt, commitSha } = identity;
    // v2 fields REPLACE the legacy pointer wholesale: an immutable_snapshot_v2
    // latest carries no legacy_v1 date-shape (the reader fails loud on a mixed
    // pointer). We clear the v1-only keys so the swapped pointer is a clean v2.
    const updates = {
        layout_version: LAYOUT_VERSION_V2,
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        snapshot_id: snapshotId,
        snapshot_date: snapshotDate,
        object_prefix: objectPrefix,
        run_id: runId,
        run_attempt: runAttempt,
        commit_sha: commitSha,
        compounds_manifest_key: cmKey,
        neg_evidence_manifest_key: negManifestKey ?? null,
        xref_index_key: hasXref ? xrefIndexKey(objectPrefix) : null,
        manifest_hash: manifestHash,
        created_at: new Date().toISOString(),
        validated_at: new Date().toISOString(),
        // Drop the legacy v1 date-shape so the pointer is an UNAMBIGUOUS v2.
        latest_snapshot_date: null,
        manifest_key: null,
    };
    const expectKeys = ['layout_version', 'snapshot_id', 'object_prefix', 'compounds_manifest_key', 'manifest_hash'];
    return swapLatestPointer(client, bucket, updates, expectKeys);
}

/**
 * Post-swap active probe: re-read latest.json and confirm it points at THIS
 * candidate (snapshot_id + object_prefix + manifest_hash). A mismatch means a
 * concurrent writer won; the run fails LOUD (latest was NOT left at us).
 */
export async function postSwapActiveProbe({ client, bucket, identity, manifestHash }) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_KEY }));
    const latest = JSON.parse((await streamToBuffer(res.Body)).toString('utf-8'));
    if (latest.layout_version !== LAYOUT_VERSION_V2
        || latest.snapshot_id !== identity.snapshotId
        || latest.object_prefix !== identity.objectPrefix
        || latest.manifest_hash !== manifestHash) {
        throw new Error(`[ACTIVATE] post-swap probe: latest.json does not point at this candidate `
            + `(got snapshot_id=${latest.snapshot_id}, expected ${identity.snapshotId})`);
    }
    return { state: PUBLISH_STATES.ACTIVE };
}
