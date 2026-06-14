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
 * candidate is VALIDATED. Any earlier failure throws before the swap (old latest
 * untouched; the half-built candidate stays under its own run-id prefix). On CAS
 * failure the candidate is retained but NOT active. RK-17: the neg key is the
 * shared { descriptorKey, validationProbeKey } contract (buildNegKeyContract) --
 * descriptor root for seal/latest, a REAL manifest for the required-inventory probe.
 */

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
    PUBLISH_STATES, LAYOUT_VERSION_V2, SNAPSHOT_SCHEMA_VERSION,
    canonicalManifestHash, rootSealKey, compoundsManifestKey,
    xrefIndexKey, searchProjectionKey, putCreateOnly,
} from './snapshot-identity.js';
import {
    satelliteInventoryForSeal, enforceCompleteSatelliteInventory,
} from './candidate-satellite-inventory.js';
import { probeCompoundSampleShard } from './candidate-shard-probe.js';
import { swapLatestPointer } from './publish-shards-and-swap.js';

const LATEST_KEY = 'snapshots/latest.json';

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
 * Run the full validated-activation sequence in strict order: build+seal
 * (OBJECTS_COMPLETE) -> validate candidate by its OWN keys (VALIDATED) -> CAS
 * the v2 latest.json (ACTIVE) -> post-swap probe. Returns { manifestHash,
 * latest }. Throws on ANY gate so the caller leaves latest.json unchanged.
 */
export async function activateValidatedCandidate({
    client, bucket, identity, compoundManifest, neg = null, hasXref, hasSearch,
    satelliteKeys = [], latestKey = LATEST_KEY,
}) {
    // RK-17: `neg` is the shared { descriptorKey, validationProbeKey } contract
    // (nullable when skipped) from buildNegKeyContract — descriptorKey = serving
    // root (seal/latest/reader); validationProbeKey = a REAL per-bucket manifest.
    // (3->4 step 5) seal LAST. satelliteKeys carries the COMPLETE satellite serving
    // inventory (RK-15) — real F4 passes the keys it published so completeness is enforced.
    const { manifestHash } = await buildAndSealCandidate({
        client, bucket, identity, compoundManifest, neg, hasXref, hasSearch, satelliteKeys,
    });
    // (step 6+7) re-read + verify the candidate by its OWN keys (never latest).
    await validateCandidate({ client, bucket, identity, expectedHash: manifestHash });
    console.log(`[ACTIVATE] candidate ${PUBLISH_STATES.VALIDATED} -> ${PUBLISH_STATES.ACTIVATABLE}`);
    // (step 9) CAS the v2 latest.json (default prod key; harness injects isolated).
    const cmKey = compoundManifestKeyOf(compoundManifest, identity.objectPrefix);
    const latest = await swapV2Latest({
        client, bucket, identity, manifestHash, compoundsManifestKey: cmKey, neg, hasXref, latestKey,
    });
    // (step 10) post-swap active validation.
    await postSwapActiveProbe({ client, bucket, identity, manifestHash, latestKey });
    return { manifestHash, latest };
}

/**
 * Build the canonical snapshot-root seal and write it LAST (create-only). The
 * seal lists the required object inventory + the compound manifest hash; the
 * canonical hash over the seal (sans its own hash field) is the manifest_hash
 * bound into latest.json. Returns { manifestHash, seal, sealKey }.
 */
export async function buildAndSealCandidate({
    client, bucket, identity, compoundManifest, neg = null, hasXref, hasSearch,
    satelliteKeys = [],
}) {
    const { snapshotId, objectPrefix, snapshotDate, runId, runAttempt, commitSha } = identity;
    // STRUCTURED required keys (compound manifest + xref + search + neg manifest):
    // existence + non-empty is the gate (the compound shard is separately decoded).
    const requiredKeys = [compoundManifestKeyOf(compoundManifest, objectPrefix)];
    if (hasXref) requiredKeys.push(xrefIndexKey(objectPrefix));
    if (hasSearch) requiredKeys.push(searchProjectionKey(objectPrefix));
    // RK-17: the neg required-inventory entry is the REAL per-bucket manifest
    // (validationProbeKey), NEVER the descriptor ROOT (a bare `/neg-evidence/`
    // prefix is not an object; HEAD-probing it 404s a complete candidate).
    if (neg && neg.validationProbeKey) requiredKeys.push(neg.validationProbeKey);
    // RK-15 full-snapshot completeness: the seal ALSO declares the COMPLETE
    // satellite serving inventory in a SEPARATE list (validateCandidate decode-
    // probes them, not just HEADs) AND folds them into required_inventory so the
    // seal hash binds the complete-snapshot definition (any drift changes the hash).
    const satelliteInventory = satelliteInventoryForSeal(satelliteKeys);
    const fullRequiredInventory = [...requiredKeys, ...satelliteInventory];

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
        // RK-17: the SERVING descriptor root (reader normalizes at `/neg-evidence/`),
        // NEVER the probe key and NEVER in required_inventory (so never HEAD-probed).
        neg_evidence_manifest_key: (neg && neg.descriptorKey) || null,
        xref_index_key: hasXref ? xrefIndexKey(objectPrefix) : null,
        compound_total_records: compoundManifest.total_records,
        compound_shard_hashes: compoundManifest.shard_hashes,
        required_inventory: fullRequiredInventory,
        satellite_inventory: satelliteInventory,
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
 * the root seal re-reads + its canonical hash matches; every STRUCTURED
 * required-inventory object exists with size > 0 (RK-17: a bare logical-prefix
 * key is refused before any HEAD); every SSoT-required SATELLITE is present +
 * reader-decodable (gunzip + a parseable record), enforced against the SSoT
 * independent of the seal's self-declaration; the compound manifest re-reads +
 * a sample shard decodes (NXVF). Throws on any gate. Returns { state: VALIDATED }.
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
    // (b) required STRUCTURED inventory: every declared object exists + non-empty.
    // Satellites are in required_inventory too (binding the seal hash) but are
    // validated MORE strictly in (b2) — skip them here so (b2) owns their errors.
    const satelliteSet = new Set(seal.satellite_inventory ?? []);
    for (const key of seal.required_inventory ?? []) {
        if (satelliteSet.has(key)) continue; // satellites validated by (b2)
        // RK-17 invariant (permanent): a probe key MUST be a real object. A bare
        // logical prefix (trailing `/`, e.g. the neg descriptor root) is NOT an R2
        // object -> HEAD would 404 a complete candidate; refuse to HEAD it.
        if (key.endsWith('/')) {
            throw new Error(`[ACTIVATE] refusing to HEAD a logical-prefix key (${key}): `
                + `a validation probe key must be a real object, not a bare prefix`);
        }
        let size;
        try { size = await headSize(client, bucket, key); }
        catch (err) { throw new Error(`[ACTIVATE] required candidate object missing: ${key} (${err.message})`); }
        if (!size || size <= 0) throw new Error(`[ACTIVATE] required candidate object is empty: ${key}`);
    }
    // (b2) RK-15 full-snapshot completeness (AUTHORITATIVE, SSoT-based): every
    // SSoT-required satellite must be present + reader-decodable at object_prefix,
    // enforced INDEPENDENT of the seal's self-declared inventory AND the caller's
    // satelliteKeys param (see candidate-satellite-inventory.js) for ANY caller.
    await enforceCompleteSatelliteInventory({ client, bucket, objectPrefix, seal });
    // (c)+(d) re-read the compound manifest, resolve a sample shard, decode NXVF.
    await probeCompoundSampleShard({ client, bucket, objectPrefix, seal });
    return { state: PUBLISH_STATES.VALIDATED };
}

/**
 * CAS-swap the v2 latest.json to ACTIVATE the validated candidate. Writes the
 * full reader-required v2 field-set (binds manifest_hash). On CAS failure the
 * candidate is RETAINED but NOT active and the old latest is unchanged (the
 * caller hard-fails the run).
 */
export async function swapV2Latest({ client, bucket, identity, manifestHash, compoundsManifestKey: cmKey, neg = null, hasXref, latestKey = LATEST_KEY }) {
    const { snapshotId, objectPrefix, snapshotDate, runId, runAttempt, commitSha } = identity;
    // v2 fields REPLACE the legacy pointer wholesale; we clear the v1-only keys so
    // the swapped pointer is a clean immutable_snapshot_v2 (reader fails on a mix).
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
        // RK-17: latest.json carries the SERVING descriptor root, never the probe key.
        neg_evidence_manifest_key: (neg && neg.descriptorKey) || null,
        xref_index_key: hasXref ? xrefIndexKey(objectPrefix) : null,
        manifest_hash: manifestHash,
        created_at: new Date().toISOString(),
        validated_at: new Date().toISOString(),
        // Drop the legacy v1 date-shape so the pointer is an UNAMBIGUOUS v2.
        latest_snapshot_date: null,
        manifest_key: null,
    };
    const expectKeys = ['layout_version', 'snapshot_id', 'object_prefix', 'compounds_manifest_key', 'manifest_hash'];
    // latestKey DEFAULTS to production snapshots/latest.json; the isolated V2
    // harness passes its OWN test pointer so production is untouched.
    return swapLatestPointer(client, bucket, updates, expectKeys, latestKey);
}

/**
 * Post-swap active probe: re-read latest.json and confirm it points at THIS
 * candidate (snapshot_id + object_prefix + manifest_hash). A mismatch means a
 * concurrent writer won; the run fails LOUD.
 */
export async function postSwapActiveProbe({ client, bucket, identity, manifestHash, latestKey = LATEST_KEY }) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: latestKey }));
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
