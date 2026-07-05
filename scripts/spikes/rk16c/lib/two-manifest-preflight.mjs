/**
 * RK-16C - TWO-MANIFEST METADATA-ONLY PREFLIGHT (D-120 A1 trust model, Option A).
 * Pure, network-free. Reads EXACTLY two metadata objects (root seal then sibling
 * `<prefix>manifest.json`) - NEVER the payload. THREE separate authorities:
 *   ROOT SEAL   = identity / object_prefix / manifest_hash / compatibility ONLY; it
 *                 does NOT attest the payload. The real F4 producer writes
 *                 satellite_inventory=[] and required_inventory=structured-keys only,
 *                 so the payload is in NEITHER seal field.
 *   MEMBERSHIP  = producer SSoT requiredSatelliteKeys(objectPrefix) (factory/lib/
 *                 snapshot-inventory.js); bioactivities.jsonl.gz IS a member.
 *   PAYLOAD PIN = sibling manifest.files[] entry (sha256/size/records), exactly-once.
 * Lock records this honestly (membership=required_satellite_ssot, pins=sibling_
 * manifest_files, root_directly_references_file_manifest=false); the seal NEVER
 * attests the payload/manifest.json.
 */

import { canonicalManifestHash, SNAPSHOT_SCHEMA_VERSION } from '../../../factory/lib/snapshot-identity.js';

export const TRUST_ANCHOR_MODE = 'producer-contract-derived-sibling-v1';
export const PRODUCER_CONTRACT_VERSION = `snapshot-schema-v${SNAPSHOT_SCHEMA_VERSION}`;
export const FILE_MANIFEST_KEY_DERIVATION = 'validated_object_prefix + "manifest.json"';
export const PAYLOAD_MEMBERSHIP_AUTHORITY = 'required_satellite_ssot';
export const PAYLOAD_PIN_AUTHORITY = 'sibling_manifest_files';
// Human-readable anchors kept for lock-schema back-compat (validateLock requires these names); values HONEST - seal does NOT attest the payload.
export const PAYLOAD_MEMBERSHIP_ANCHOR = 'producer required-satellite SSoT (requiredSatelliteKeys); the root seal does NOT attest the payload';
export const FILE_MANIFEST_ADMISSIBILITY_ANCHOR = 'deterministic sibling key + create-only producer co-publication; payload pins from sibling manifest.files[]';

const SHA256_RE = /^[0-9a-f]{64}$/;
const FAIL = (msg) => { throw new Error(`[rk16c-2manifest] ${msg}`); };

/** object_prefix `snapshots/<snapshot_id>/` - ALWAYS ends with `/`. */
export function deriveObjectPrefix(snapshotId) {
    if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
        FAIL('snapshot_id missing - cannot derive object_prefix');
    }
    return `snapshots/${snapshotId}/`;
}

/** Deterministic per-file manifest sibling key - from a validated object_prefix ONLY, NEVER from List/discovery/latest/CLI free-text. */
export function deriveFileManifestKey(objectPrefix) {
    if (typeof objectPrefix !== 'string' || !objectPrefix.endsWith('/')) {
        FAIL(`object_prefix must end with "/" (got ${JSON.stringify(objectPrefix)})`);
    }
    return `${objectPrefix}manifest.json`;
}

/** Bare snapshot-relative filename for a full key under the prefix. THROWS on prefix escape / nested path / '..'. */
function relativeUnderPrefix(key, objectPrefix, label) {
    if (typeof key !== 'string' || !key.startsWith(objectPrefix)) {
        FAIL(`${label} key ${JSON.stringify(key)} escapes validated object_prefix ${JSON.stringify(objectPrefix)} - fail closed`);
    }
    const rel = key.slice(objectPrefix.length);
    if (rel.length === 0 || rel.includes('/') || rel.includes('..')) {
        FAIL(`${label} filename ${JSON.stringify(rel)} is not a bare sibling under the prefix - fail closed`);
    }
    return rel;
}

/** The payload's bare filename under the validated prefix (fail-closed on escape). */
export function payloadRelativeFilename(payloadKey, objectPrefix) {
    return relativeUnderPrefix(payloadKey, objectPrefix, 'payload');
}

/** STAGE 1 - validate the root seal (identity/object_prefix/manifest_hash ONLY; it
 *  does NOT attest the payload): snapshot_id + object_prefix match, layout/schema
 *  presence, manifest_hash recompute over sealCore (== stored). satellite_inventory
 *  / required_inventory are AUDIT-only. THROWS (fail-closed) on mismatch. */
export function validateRootSeal(sealBody, { snapshotId }) {
    const text = Buffer.isBuffer(sealBody) ? sealBody.toString('utf-8') : String(sealBody);
    let seal;
    try { seal = JSON.parse(text); }
    catch (e) { FAIL(`root seal is not valid JSON: ${e?.message ?? e}`); }
    if (!seal || typeof seal !== 'object' || Array.isArray(seal)) FAIL('root seal is not a JSON object');

    if (seal.snapshot_id !== snapshotId) {
        FAIL(`root seal snapshot_id mismatch: pinned=${snapshotId} seal=${seal.snapshot_id} (NEVER auto-switch)`);
    }
    const expectedPrefix = deriveObjectPrefix(snapshotId);
    if (seal.object_prefix !== expectedPrefix) {
        FAIL(`root seal object_prefix mismatch: expected=${expectedPrefix} seal=${seal.object_prefix}`);
    }
    if (seal.layout_version == null || seal.schema_version == null) {
        FAIL('root seal missing layout_version/schema_version');
    }
    const storedHash = seal.manifest_hash;
    if (typeof storedHash !== 'string' || !SHA256_RE.test(storedHash)) {
        FAIL(`root seal manifest_hash absent/invalid: ${JSON.stringify(storedHash)}`);
    }
    const { manifest_hash: _omit, ...sealCore } = seal;
    const recomputed = canonicalManifestHash(sealCore);
    if (recomputed !== storedHash) {
        FAIL(`root seal manifest_hash mismatch: stored=${storedHash} recomputed=${recomputed}`);
    }
    return {
        snapshot_id: seal.snapshot_id,
        object_prefix: seal.object_prefix,
        production_run_id: seal.run_id != null && seal.run_attempt != null
            ? `${seal.run_id}-${seal.run_attempt}`
            : (snapshotId.split('/')[1] || null),
        layout_version: seal.layout_version,
        schema_version: seal.schema_version,
        // AUDIT-only (NOT a membership authority): production seals carry [] in both.
        satellite_inventory: Array.isArray(seal.satellite_inventory) ? seal.satellite_inventory : [],
        required_inventory: Array.isArray(seal.required_inventory) ? seal.required_inventory : [],
        stored_hash: storedHash,
        recomputed_hash: recomputed,
    };
}

/** PAYLOAD-CLASS MEMBERSHIP (pure). Fail-closed unless `payloadKey` appears EXACTLY
 *  ONCE in `requiredSatelliteKeyList` (producer SSoT): 0 -> absent from the
 *  required-satellite contract; >1 -> duplicated (frozen+unique in production). */
export function assertPayloadIsRequiredSatellite(requiredSatelliteKeyList, payloadKey) {
    if (!Array.isArray(requiredSatelliteKeyList)) {
        FAIL('required-satellite key list is not an array - cannot assert payload membership');
    }
    const hits = requiredSatelliteKeyList.filter((k) => k === payloadKey).length;
    if (hits === 0) {
        FAIL(`payload key ${payloadKey} absent from required-satellite contract (producer SSoT) - fail closed`);
    }
    if (hits > 1) {
        FAIL(`payload key ${payloadKey} duplicated (${hits}x) in required-satellite contract - fail closed`);
    }
    return { member: true, occurrences: hits };
}

/** STAGE 2 - validate the sibling per-file manifest. Present snapshot_id/
 *  object_prefix MUST match; files[] must be bare-name entries (no path escape, no
 *  dup). Returns { files, schema_version, production_run_id, identity_available }. */
export function validateFileManifest(fileManifestBody, { snapshotId, objectPrefix }) {
    const text = Buffer.isBuffer(fileManifestBody) ? fileManifestBody.toString('utf-8') : String(fileManifestBody);
    let manifest;
    try { manifest = JSON.parse(text); }
    catch (e) { FAIL(`per-file manifest is not valid JSON: ${e?.message ?? e}`); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        FAIL('per-file manifest is not a JSON object');
    }
    const identity_available = {
        snapshot_id: manifest.snapshot_id != null,
        object_prefix: manifest.object_prefix != null,
        production_run_id: manifest.run_id != null,
        schema_version: manifest.schema_version != null,
    };
    if (identity_available.snapshot_id && manifest.snapshot_id !== snapshotId) {
        FAIL(`per-file manifest snapshot_id mismatch: pinned=${snapshotId} manifest=${manifest.snapshot_id}`);
    }
    if (identity_available.object_prefix && manifest.object_prefix !== objectPrefix) {
        FAIL(`per-file manifest object_prefix mismatch: expected=${objectPrefix} manifest=${manifest.object_prefix}`);
    }
    const files = Array.isArray(manifest.files) ? manifest.files : null;
    if (!files) FAIL('per-file manifest has no files[] array - refusing to fabricate payload pins');
    const seenNames = new Set();
    for (const f of files) {
        if (!f || typeof f !== 'object') FAIL('per-file manifest files[] contains a non-object entry');
        const name = f.filename;
        if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('..')) {
            FAIL(`files[] entry filename ${JSON.stringify(name)} escapes validated object_prefix / not a bare name - fail closed`);
        }
        if (seenNames.has(name)) FAIL(`duplicate files[] filename: ${name} - fail closed`);
        seenNames.add(name);
    }
    return {
        files,
        schema_version: identity_available.schema_version ? manifest.schema_version : null,
        production_run_id: identity_available.production_run_id ? String(manifest.run_id) : null,
        identity_available,
    };
}

/** PAYLOAD PIN (payload-scoped) - the single sibling files[] entry whose bare
 *  filename === payloadFilename, pins validated. Extra (non-payload) files[]
 *  entries are ALLOWED. Fail-closed unless the payload appears EXACTLY ONCE with a
 *  64-hex sha256_compressed + positive-int compressed_bytes (+ records if present). */
export function extractPayloadPin(files, payloadFilename) {
    if (!Array.isArray(files)) FAIL('sibling manifest files[] is not an array - refusing to fabricate payload pins');
    const matches = files.filter((f) => f && f.filename === payloadFilename);
    if (matches.length === 0) {
        FAIL(`payload ${payloadFilename} absent from sibling manifest.files[] - no approvable lock (refusing to fabricate payload pins)`);
    }
    if (matches.length > 1) {
        FAIL(`payload ${payloadFilename} duplicated (${matches.length}x) in sibling manifest.files[] - fail closed`);
    }
    const entry = matches[0];
    const { sha256_compressed, compressed_bytes, records } = entry;
    if (typeof sha256_compressed !== 'string' || !SHA256_RE.test(sha256_compressed)) {
        FAIL(`payload ${payloadFilename} sha256_compressed invalid: ${JSON.stringify(sha256_compressed)} - fail closed`);
    }
    if (!Number.isInteger(compressed_bytes) || compressed_bytes <= 0) {
        FAIL(`payload ${payloadFilename} compressed_bytes invalid: ${JSON.stringify(compressed_bytes)} - fail closed`);
    }
    if (records != null && (!Number.isInteger(records) || records <= 0)) {
        FAIL(`payload ${payloadFilename} records invalid: ${JSON.stringify(records)} - fail closed`);
    }
    return {
        sha256_compressed,
        compressed_bytes,
        records: records != null ? records : null,
        uncompressed_bytes: Number.isInteger(entry.uncompressed_bytes) ? entry.uncompressed_bytes : null,
        sha256_uncompressed: typeof entry.sha256_uncompressed === 'string' ? entry.sha256_uncompressed : null,
        compression_ratio: typeof entry.compression_ratio === 'number' ? entry.compression_ratio : null,
    };
}

/** ASSEMBLE the candidate-lock v2 (pure, UNRATIFIED / audit-input-only). Records
 *  root_directly_references_file_manifest=false, membership authority = producer
 *  required-satellite SSoT, pin authority = sibling manifest.files[]. NEVER claims
 *  cryptographic root linkage. */
export function assembleCandidateLock(parts) {
    const {
        seal, fileManifest, payloadKey, payloadFilename, pins,
        rootManifestRead, fileManifestRead, expectedRowCount, provenance = {},
    } = parts;
    return {
        candidate_lock_schema: 'rk16c-fullcorpus-lock-v2',
        // trust-anchor model (D-120 Option A)
        trust_anchor_mode: TRUST_ANCHOR_MODE,
        root_directly_references_file_manifest: false,
        file_manifest_key_derivation: FILE_MANIFEST_KEY_DERIVATION,
        payload_membership_authority: PAYLOAD_MEMBERSHIP_AUTHORITY,
        payload_pin_authority: PAYLOAD_PIN_AUTHORITY,
        payload_membership_anchor: PAYLOAD_MEMBERSHIP_ANCHOR,
        file_manifest_admissibility_anchor: FILE_MANIFEST_ADMISSIBILITY_ANCHOR,
        root_manifest_key: rootManifestRead.key,
        root_manifest_etag: rootManifestRead.etag,
        root_manifest_byte_size: rootManifestRead.byte_size,
        root_manifest_sha256: rootManifestRead.sha256,
        root_manifest_stored_hash: seal.stored_hash,
        root_manifest_recomputed_hash: seal.recomputed_hash,
        file_manifest_key: fileManifestRead.key,
        file_manifest_etag: fileManifestRead.etag,
        file_manifest_byte_size: fileManifestRead.byte_size,
        file_manifest_sha256: fileManifestRead.sha256,
        file_manifest_schema_version: fileManifest.schema_version,
        file_manifest_identity_available: fileManifest.identity_available,
        payload_key: payloadKey, // payload_pin_authority = sibling manifest.files[]
        payload_filename: payloadFilename,
        payload_sha256_compressed: pins.sha256_compressed,
        payload_compressed_bytes: pins.compressed_bytes,
        payload_uncompressed_bytes: pins.uncompressed_bytes,
        payload_sha256_uncompressed: pins.sha256_uncompressed,
        expected_row_count: pins.records != null ? pins.records : expectedRowCount,
        payload_schema_version: null, // not in the producer per-payload schema; NOT fabricated
        snapshot_id: seal.snapshot_id,
        production_run_id: seal.production_run_id,
        producer_contract_version: PRODUCER_CONTRACT_VERSION,
        created_by_workflow_run: provenance.workflow_run ?? null,
        created_from_runner_sha: provenance.runner_sha ?? null,
        created_from_workflow_sha: provenance.workflow_sha ?? null,
    };
}
