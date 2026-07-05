/**
 * RK-16C FULL-CORPUS SPIKE (H) - STRICT READ-ONLY R2 CORPUS ACQUISITION ADAPTER.
 *
 * SAFE BY DEFAULT: --dry-run performs NO network call; it computes the EXACT
 * TWO snapshot-namespace keys (manifest + payload; M1 removed the mutable
 * snapshots/latest.json alias from EVERY read path) + estimates.
 *
 * TWO-STAGE (M3), both BUILD-inert here: --preflight is METADATA-ONLY (seal +
 * sibling manifest keys only, small byte caps, NO payload GET; under a future gate
 * it emits the lock - payload PINS come FROM THE SIBLING manifest.files[], payload
 * MEMBERSHIP from the producer required-satellite SSoT). --execute is the FULL RUN
 * (fullcorpus-execute.mjs): it loads + require()s a COMPLETE founder-reviewed LOCK
 * BEFORE any payload GET (fail-before-network), then STREAMS the payload GET and
 * verifies sha256/size against the lock.
 *
 * Every read is wrapped by the STRICTER instrumentExactReadOnlyClient (M2, passed
 * in as deps.instrument): ONLY HeadObject/GetObject of an ALLOWLISTED key;
 * List/discovery, any non-allowlisted key, any PUT/DELETE/COPY/multipart, any
 * latest resolution all THROW before the store. Memory + disk guards (M4) apply.
 * NO fabricated hashes.
 */

import { createHash } from 'crypto';
import {
    consumedObjectKeys, bioactivitiesObjectKey, manifestObjectKey,
    fileManifestObjectKey, CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT, proposeIdentity,
} from './corpus-identity.mjs';
import {
    validateRootSeal, validateFileManifest, deriveFileManifestKey,
    assertPayloadIsRequiredSatellite, payloadRelativeFilename, extractPayloadPin,
    assembleCandidateLock,
} from './two-manifest-preflight.mjs';
// Producer SSoT - PURE symbol ONLY; this path NEVER constructs/sends an S3 client.
import { requiredSatelliteKeys } from '../../../factory/lib/snapshot-inventory.js';
// Full-run + materialization live in fullcorpus-execute.mjs (250-line cap); the
// adapter re-exports them so callers/tests keep their existing import paths.
import {
    executeFullRun, materializationDir, atomicMaterialize, cleanup,
    MAX_REQUESTS, MAX_TOTAL_BYTES,
} from './fullcorpus-execute.mjs';

export {
    executeFullRun, materializationDir, atomicMaterialize, cleanup,
    MAX_REQUESTS, MAX_TOTAL_BYTES,
};

/** HARD caps - fail-closed past any (a runaway read is a defect, not a retry). */
export const MAX_OBJECTS = 2;                   // exactly TWO metadata objects (seal + manifest.json)
// D-103 S9 metadata byte caps. The seal + sibling manifest are small (a handful of
// KiB each in production); 2 MiB per object is a bounded, far-from-unlimited ceiling
// and 4 MiB combined caps both reads. Cap breach FAILS CLOSED before lock creation.
export const MAX_ROOT_MANIFEST_BYTES = 2 * 1024 * 1024;  // root seal cap (2 MiB)
export const MAX_FILE_MANIFEST_BYTES = 2 * 1024 * 1024;  // per-file manifest cap (2 MiB)
export const MAX_METADATA_TOTAL_BYTES = MAX_ROOT_MANIFEST_BYTES + MAX_FILE_MANIFEST_BYTES; // 4 MiB
export const MAX_MANIFEST_BYTES = MAX_ROOT_MANIFEST_BYTES; // back-compat alias (root seal cap)
/** Per-object byte estimate for the satellite (compressed gz, EXPECTED-ONLY). */
export const EST_BIOACTIVITIES_BYTES = 60 * 1024 * 1024; // ~60 MiB est (gz)
export const EST_MANIFEST_BYTES = 64 * 1024;

export function redact(s) {
    if (s == null) return s;
    return String(s)
        .replace(/(access[_-]?key[_-]?id["':=\s]*)([^\s"',}]+)/gi, '$1***REDACTED***')
        .replace(/(secret[_-]?access[_-]?key["':=\s]*)([^\s"',}]+)/gi, '$1***REDACTED***')
        .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***REDACTED***@')
        .replace(/[A-Za-z0-9]{32,}/g, (m) => (m.length >= 40 ? '***REDACTED***' : m));
}
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

/**
 * Compute the dry-run plan (NO network). The proposed object keys = exactly the
 * TWO snapshot-namespace keys (manifest, payload). NO latest alias anywhere.
 */
export function computeDryRunPlan(opts = {}) {
    const snapshotId = opts.snapshot || CANDIDATE_SNAPSHOT_ID;
    const expectedRows = opts.expectedRows != null ? opts.expectedRows : EXPECTED_ROW_COUNT;
    const keys = consumedObjectKeys(snapshotId); // [manifest, payload] - no latest
    const identity = proposeIdentity({
        snapshot_id: snapshotId, expected_row_count: expectedRows,
        build_commit: opts.buildCommit || null,
    });
    const estimated_request_count = keys.length * 2; // 1 HEAD + 1 GET per object
    const estimated_total_bytes = EST_MANIFEST_BYTES + EST_BIOACTIVITIES_BYTES;
    return {
        mode: 'dry-run',
        snapshot_id: snapshotId,
        expected_row_count: expectedRows,
        proposed_object_keys: keys,
        allowlist: keys,
        forbidden_keys: ['snapshots/latest.json'], // M1: never in any read path
        estimated_request_count,
        estimated_object_count: keys.length,
        estimated_total_bytes,
        hard_caps: {
            max_requests: MAX_REQUESTS, max_objects: MAX_OBJECTS,
            max_total_bytes: MAX_TOTAL_BYTES, max_manifest_bytes: MAX_MANIFEST_BYTES,
        },
        per_object_byte_estimates: {
            [manifestObjectKey(snapshotId)]: EST_MANIFEST_BYTES,
            [bioactivitiesObjectKey(snapshotId)]: EST_BIOACTIVITIES_BYTES,
        },
        identity_envelope: identity,
        network_performed: false,
        within_caps: estimated_request_count <= MAX_REQUESTS
            && keys.length <= MAX_OBJECTS
            && estimated_total_bytes <= MAX_TOTAL_BYTES,
    };
}

/** Best-effort execution provenance for the candidate lock (null off-Actions). */
function readProvenance() {
    const run = process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
        : null;
    return {
        workflow_run: run,
        runner_sha: process.env.AUDITED_RUNNER_SHA || process.env.GITHUB_SHA || null,
        workflow_sha: process.env.WORKFLOW_DEFINITION_SHA || process.env.GITHUB_SHA || null,
    };
}

/**
 * STAGE 1+2 - TWO-MANIFEST METADATA-ONLY PREFLIGHT (D-120 A1). Reads EXACTLY two
 * metadata objects under the validated immutable prefix - the root seal then the
 * deterministic sibling manifest - and NEVER the payload. Stage 1 validates the
 * seal (identity + object_prefix + recomputed manifest_hash) as an IDENTITY anchor
 * ONLY; it does NOT attest the payload. The sibling key is derived from the
 * VALIDATED object_prefix and asserted equal to the allowlisted key BEFORE the
 * second read. Stage 2 validates the sibling manifest; payload-CLASS membership is
 * then asserted against the producer required-satellite SSoT (pure) and the payload
 * PINS are extracted, payload-scoped, from the sibling manifest.files[]. Returns an
 * assembled UNRATIFIED candidate lock. Refuses unless execute===true AND a snapshot
 * pin AND --manifest-key === the exact seal key.
 */
export async function preflightManifest(opts, deps) {
    if (opts.execute !== true) {
        throw new Error('[rk16c-adapter] refusing preflight: --execute not set (default is dry-run)');
    }
    if (!opts.snapshot) {
        throw new Error('[rk16c-adapter] refusing preflight: no snapshot pin supplied');
    }
    const snapshotId = opts.snapshot;
    const sealKey = manifestObjectKey(snapshotId);
    const manifestKey = opts.manifestKey || sealKey;
    if (manifestKey !== sealKey) {
        throw new Error(`[rk16c-adapter] preflight manifest-key mismatch: ${manifestKey} != ${sealKey} - fail-closed`);
    }
    const payloadKey = bioactivitiesObjectKey(snapshotId);
    // The sibling manifest key is deterministic - derived ONLY from the pinned
    // snapshot prefix, NEVER from caller input/List/latest. It is re-asserted
    // against the VALIDATED seal object_prefix before Stage 2.
    const fileManifestKey = fileManifestObjectKey(snapshotId);
    // EXACT allowlist = the TWO metadata keys ONLY (no payload, ever).
    const guarded = deps.instrument(deps.makeClient(), [sealKey, fileManifestKey]);

    // ---- Stage 1: root seal (identity / object_prefix / manifest_hash ONLY) ----
    const sealHead = await deps.headObject(guarded, deps.bucket, sealKey);
    if ((sealHead.size || 0) > MAX_ROOT_MANIFEST_BYTES) {
        throw new Error(`[rk16c-adapter] root-manifest byte cap exceeded (HEAD ${sealHead.size} > ${MAX_ROOT_MANIFEST_BYTES}) - fail-closed BEFORE GET`);
    }
    const sealGot = await deps.getObject(guarded, deps.bucket, sealKey);
    const sealSha = sha256(sealGot.body);
    const sealFacts = validateRootSeal(sealGot.body, { snapshotId });
    // FAIL BEFORE SECOND READ if the sibling key derived from the validated
    // object_prefix does not equal the allowlisted/expected sibling key.
    const derivedFileKey = deriveFileManifestKey(sealFacts.object_prefix);
    if (derivedFileKey !== fileManifestKey) {
        throw new Error(`[rk16c-adapter] derived sibling manifest key ${derivedFileKey} != expected ${fileManifestKey} - FAIL BEFORE SECOND METADATA READ`);
    }

    // ---- Stage 2: deterministic sibling manifest ----
    const fmHead = await deps.headObject(guarded, deps.bucket, fileManifestKey);
    if ((fmHead.size || 0) > MAX_FILE_MANIFEST_BYTES) {
        throw new Error(`[rk16c-adapter] per-file manifest byte cap exceeded (HEAD ${fmHead.size} > ${MAX_FILE_MANIFEST_BYTES}) - fail-closed BEFORE GET`);
    }
    const fmGot = await deps.getObject(guarded, deps.bucket, fileManifestKey);
    const fmSha = sha256(fmGot.body);
    if ((sealGot.size + fmGot.size) > MAX_METADATA_TOTAL_BYTES) {
        throw new Error(`[rk16c-adapter] combined metadata byte cap exceeded (${sealGot.size}+${fmGot.size} > ${MAX_METADATA_TOTAL_BYTES}) - fail-closed`);
    }
    const fmFacts = validateFileManifest(fmGot.body, { snapshotId, objectPrefix: sealFacts.object_prefix });

    // ---- payload-CLASS membership (producer SSoT; PURE - no S3 client) then
    //      payload PIN extraction (payload-scoped) from the sibling files[] ----
    assertPayloadIsRequiredSatellite(requiredSatelliteKeys(sealFacts.object_prefix), payloadKey);
    const payloadFilename = payloadRelativeFilename(payloadKey, sealFacts.object_prefix);
    const pins = extractPayloadPin(fmFacts.files, payloadFilename);

    const candidate = assembleCandidateLock({
        seal: sealFacts,
        fileManifest: fmFacts,
        payloadKey,
        payloadFilename,
        pins,
        rootManifestRead: { key: sealKey, etag: sealHead.etag, byte_size: sealGot.size, sha256: sealSha },
        fileManifestRead: { key: fileManifestKey, etag: fmHead.etag, byte_size: fmGot.size, sha256: fmSha },
        expectedRowCount: opts.expectedRows,
        provenance: readProvenance(),
    });

    return {
        mode: 'preflight',
        network_performed: true,
        snapshot_id: snapshotId,
        root_manifest_key: sealKey,
        file_manifest_key: fileManifestKey,
        payload_key: payloadKey,
        candidate,
        requests_used: guarded.callCount,
        list_attempt_count: guarded.list_attempt_count,
        non_allowlisted_key_attempt_count: guarded.non_allowlisted_key_attempt_count,
        note: 'METADATA-ONLY (A1): two metadata objects read (seal + manifest.json); NO payload GET. Membership=required-satellite SSoT; pins=sibling manifest.files[]. Lock is UNRATIFIED + founder-gated.',
    };
}
