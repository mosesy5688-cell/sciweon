/**
 * RK-16C FULL-CORPUS SPIKE — TWO-MANIFEST METADATA-ONLY PREFLIGHT (A1 trust anchor).
 *
 * Pure, network-free validation logic for the D-103 A1 trust chain. The root
 * seal (`<prefix>_snapshot.manifest.json`) does NOT reference or hash the
 * per-file manifest (`<prefix>manifest.json`), so this is an AUDITABLE
 * COMPATIBILITY trust chain — NOT a cryptographic root linkage. Admissibility of
 * manifest.json rests on: (1) a validated immutable snapshot prefix from the
 * seal; (2) deterministic sibling-key derivation; (3) create-only co-publication
 * by the same producer/run under the same immutable prefix; (4) the PAYLOAD key
 * appearing exactly once in the seal's satellite_inventory; (5) strict
 * manifest.files[] <-> satellite_inventory reconciliation. We NEVER claim the
 * seal authenticates manifest.json.
 *
 * Producer grounding (code, no R2):
 *   - root seal sealCore  -> scripts/factory/lib/stage-4-activate.js:114-145
 *     (object_prefix, snapshot_id, run_id, run_attempt, satellite_inventory =
 *      requiredSatelliteKeys = `<prefix><key_suffix>` payload keys, manifest_hash
 *      over sealCore WITHOUT its own hash field via canonicalManifestHash).
 *   - satellite_inventory -> scripts/factory/lib/snapshot-inventory.js:213-215.
 *   - manifest.json       -> scripts/factory/snapshot-builder.js:88-152 (top-level
 *     snapshot_id/object_prefix/schema_version/run_id + files[] each
 *     {filename:`<fname>.gz`, records, compressed_bytes, sha256_compressed, ...}).
 *   - sibling co-publish  -> scripts/factory/snapshot-uploader.js:83-101 (every
 *     top-level file create-only PUT to `<object_prefix><fname>`), orchestrated
 *     builder-then-uploader-then-seal in scripts/factory/stage-4-upload.js:151-183.
 *
 * SATELLITE PROJECTION RULE (from producer code, NOT filename guessing): a seal
 * satellite_inventory entry is the full key `<object_prefix><key_suffix>`; the
 * matching manifest.files[] entry has `filename === <key_suffix>`. So the
 * satellite-payload projection of files[] = { f in files : f.filename in
 * normalize(satellite_inventory) } where normalize strips the validated
 * object_prefix. Extra (non-satellite) files[] entries (e.g. xref-index.json.gz,
 * compounds-search.jsonl.gz) MAY exist and are NOT treated as satellites.
 */

import { canonicalManifestHash, SNAPSHOT_SCHEMA_VERSION } from '../../../factory/lib/snapshot-identity.js';

export const TRUST_ANCHOR_MODE = 'producer-contract-derived-sibling-v1';
export const PRODUCER_CONTRACT_VERSION = `snapshot-schema-v${SNAPSHOT_SCHEMA_VERSION}`;
export const FILE_MANIFEST_KEY_DERIVATION = 'validated_object_prefix + "manifest.json"';
export const PAYLOAD_MEMBERSHIP_ANCHOR = 'root satellite_inventory';
export const FILE_MANIFEST_ADMISSIBILITY_ANCHOR =
    'deterministic sibling key + immutable create-only producer contract + inventory reconciliation';

const SHA256_RE = /^[0-9a-f]{64}$/;
const FAIL = (msg) => { throw new Error(`[rk16c-2manifest] ${msg}`); };

/** object_prefix `snapshots/<snapshot_id>/` — ALWAYS ends with `/`. Mirrors the
 *  producer objectPrefixFor (snapshot-identity.js:67-69). */
export function deriveObjectPrefix(snapshotId) {
    if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
        FAIL('snapshot_id missing — cannot derive object_prefix');
    }
    return `snapshots/${snapshotId}/`;
}

/** The deterministic per-file manifest sibling key. NEVER from List/discovery/
 *  latest/CLI free-text — derived ONLY from a validated object_prefix. */
export function deriveFileManifestKey(objectPrefix) {
    if (typeof objectPrefix !== 'string' || !objectPrefix.endsWith('/')) {
        FAIL(`object_prefix must end with "/" (got ${JSON.stringify(objectPrefix)})`);
    }
    return `${objectPrefix}manifest.json`;
}

/** The payload's snapshot-relative filename from its full key under the prefix. */
function relativeUnderPrefix(key, objectPrefix, label) {
    if (typeof key !== 'string' || !key.startsWith(objectPrefix)) {
        FAIL(`${label} key ${JSON.stringify(key)} escapes validated object_prefix ${JSON.stringify(objectPrefix)} — fail closed`);
    }
    const rel = key.slice(objectPrefix.length);
    if (rel.length === 0 || rel.includes('/') || rel.includes('..')) {
        FAIL(`${label} filename ${JSON.stringify(rel)} is not a bare sibling under the prefix — fail closed`);
    }
    return rel;
}

/**
 * STAGE 1 — validate the root seal (already read). Recomputes manifest_hash over
 * sealCore (seal minus manifest_hash) and asserts stored===recomputed. Asserts
 * snapshot identity + object_prefix + that the payload key occurs EXACTLY ONCE in
 * satellite_inventory. Returns the validated facts. THROWS (fail-closed) on any
 * mismatch.
 *
 * @param {Buffer|string} sealBody  exact root-seal bytes
 * @param {object} pin  { snapshotId, payloadKey }
 */
export function validateRootSeal(sealBody, { snapshotId, payloadKey }) {
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
    // Recompute the seal hash over sealCore (everything EXCEPT manifest_hash).
    const storedHash = seal.manifest_hash;
    if (typeof storedHash !== 'string' || !SHA256_RE.test(storedHash)) {
        FAIL(`root seal manifest_hash absent/invalid: ${JSON.stringify(storedHash)}`);
    }
    const { manifest_hash: _omit, ...sealCore } = seal;
    const recomputed = canonicalManifestHash(sealCore);
    if (recomputed !== storedHash) {
        FAIL(`root seal manifest_hash mismatch: stored=${storedHash} recomputed=${recomputed}`);
    }
    const satelliteInventory = Array.isArray(seal.satellite_inventory) ? seal.satellite_inventory : null;
    if (!satelliteInventory) FAIL('root seal satellite_inventory absent/not an array');
    const requiredInventory = Array.isArray(seal.required_inventory) ? seal.required_inventory : [];

    // Payload membership: EXACTLY ONCE in satellite_inventory.
    const payloadHits = satelliteInventory.filter((k) => k === payloadKey).length;
    if (payloadHits === 0) FAIL(`payload key ${payloadKey} absent from satellite_inventory — fail closed`);
    if (payloadHits > 1) FAIL(`payload key ${payloadKey} duplicated (${payloadHits}x) in satellite_inventory — fail closed`);

    return {
        snapshot_id: seal.snapshot_id,
        object_prefix: seal.object_prefix,
        production_run_id: seal.run_id != null && seal.run_attempt != null
            ? `${seal.run_id}-${seal.run_attempt}`
            : (snapshotId.split('/')[1] || null),
        layout_version: seal.layout_version,
        schema_version: seal.schema_version,
        satellite_inventory: satelliteInventory,
        required_inventory: requiredInventory,
        stored_hash: storedHash,
        recomputed_hash: recomputed,
    };
}

/**
 * Normalize satellite_inventory full keys -> bare snapshot-relative filenames,
 * asserting each is under the validated prefix and no two normalize to the same
 * filename. Returns the filename array.
 */
export function normalizeSatelliteInventory(satelliteInventory, objectPrefix) {
    const seen = new Set();
    const out = [];
    for (const key of satelliteInventory) {
        const rel = relativeUnderPrefix(key, objectPrefix, 'satellite_inventory');
        if (seen.has(rel)) FAIL(`normalized satellite filename collision: ${rel} — fail closed`);
        seen.add(rel);
        out.push(rel);
    }
    return out;
}

/**
 * STAGE 2 — validate the per-file manifest (already read from the deterministic
 * sibling key). Does NOT fabricate identity: if snapshot_id/object_prefix are
 * present they MUST match; if absent, that is recorded (admissibility then rests
 * on the sibling-key + producer contract + reconciliation). Returns
 * { files, schema_version, identity_available }. THROWS on structural failure.
 */
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
    if (!files) FAIL('per-file manifest has no files[] array — refusing to fabricate payload pins');
    // Every entry must be a bare sibling filename (no path escape).
    const seenNames = new Set();
    for (const f of files) {
        if (!f || typeof f !== 'object') FAIL('per-file manifest files[] contains a non-object entry');
        const name = f.filename;
        if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('..')) {
            FAIL(`files[] entry filename ${JSON.stringify(name)} escapes validated object_prefix / not a bare name — fail closed`);
        }
        if (seenNames.has(name)) FAIL(`duplicate files[] filename: ${name} — fail closed`);
        seenNames.add(name);
    }
    return {
        files,
        schema_version: identity_available.schema_version ? manifest.schema_version : null,
        production_run_id: identity_available.production_run_id ? String(manifest.run_id) : null,
        identity_available,
    };
}

/**
 * SET-LEVEL reconciliation: every normalized satellite filename has EXACTLY ONE
 * files[] entry (the satellite-payload projection of files[] is a bijection onto
 * the normalized satellite set). Extra non-satellite files[] entries are allowed.
 * THROWS on any missing/extra/duplicate. Returns the projection (filename->entry).
 */
export function reconcileFilesWithInventory(files, normalizedSatellites) {
    const byName = new Map();
    for (const f of files) {
        // files[] filenames already de-duped by validateFileManifest.
        byName.set(f.filename, f);
    }
    const projection = new Map();
    for (const sat of normalizedSatellites) {
        const entry = byName.get(sat);
        if (!entry) {
            FAIL(`root-declared satellite ${sat} has no entry in manifest.files[] — unreconcilable satellite projection (fail closed)`);
        }
        projection.set(sat, entry);
    }
    // Bijection check: the projection covers exactly the normalized satellite set.
    if (projection.size !== normalizedSatellites.length) {
        FAIL(`satellite projection size ${projection.size} != satellite_inventory size ${normalizedSatellites.length} — fail closed`);
    }
    return projection;
}

/**
 * TARGET-LEVEL: extract the single bioactivities files[] entry + validate its
 * pins. THROWS on missing/duplicate/invalid. `projection` is from
 * reconcileFilesWithInventory (so the target is guaranteed a satellite member).
 */
export function extractBioactivitiesEntry(projection, payloadFilename) {
    const entry = projection.get(payloadFilename);
    if (!entry) {
        FAIL(`target ${payloadFilename} not present in satellite projection — no approvable lock (refusing to fabricate payload pins)`);
    }
    const { sha256_compressed, compressed_bytes, records } = entry;
    if (typeof sha256_compressed !== 'string' || !SHA256_RE.test(sha256_compressed)) {
        FAIL(`target ${payloadFilename} sha256_compressed invalid: ${JSON.stringify(sha256_compressed)} — fail closed`);
    }
    if (!Number.isInteger(compressed_bytes) || compressed_bytes <= 0) {
        FAIL(`target ${payloadFilename} compressed_bytes invalid: ${JSON.stringify(compressed_bytes)} — fail closed`);
    }
    if (records != null && (!Number.isInteger(records) || records <= 0)) {
        FAIL(`target ${payloadFilename} records invalid: ${JSON.stringify(records)} — fail closed`);
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

/**
 * ASSEMBLE the candidate-lock v2 trust-anchor object from the validated facts.
 * Pure: records explicitly that the root seal does NOT reference manifest.json
 * (root_directly_references_file_manifest=false) and the trust_anchor_mode. NEVER
 * claims direct cryptographic root linkage.
 */
export function assembleCandidateLock(parts) {
    const {
        seal, fileManifest, payloadKey, payloadFilename, pins,
        rootManifestRead, fileManifestRead, expectedRowCount, provenance = {},
    } = parts;
    return {
        candidate_lock_schema: 'rk16c-fullcorpus-lock-v2',
        // ---- trust-anchor model (D-103 §9) ----
        trust_anchor_mode: TRUST_ANCHOR_MODE,
        root_directly_references_file_manifest: false,
        file_manifest_key_derivation: FILE_MANIFEST_KEY_DERIVATION,
        payload_membership_anchor: PAYLOAD_MEMBERSHIP_ANCHOR,
        file_manifest_admissibility_anchor: FILE_MANIFEST_ADMISSIBILITY_ANCHOR,
        // ---- root-manifest (seal) identity ----
        root_manifest_key: rootManifestRead.key,
        root_manifest_etag: rootManifestRead.etag,
        root_manifest_byte_size: rootManifestRead.byte_size,
        root_manifest_sha256: rootManifestRead.sha256,
        root_manifest_stored_hash: seal.stored_hash,
        root_manifest_recomputed_hash: seal.recomputed_hash,
        // ---- per-file manifest identity ----
        file_manifest_key: fileManifestRead.key,
        file_manifest_etag: fileManifestRead.etag,
        file_manifest_byte_size: fileManifestRead.byte_size,
        file_manifest_sha256: fileManifestRead.sha256,
        file_manifest_schema_version: fileManifest.schema_version,
        file_manifest_identity_available: fileManifest.identity_available,
        // ---- payload identity ----
        payload_key: payloadKey,
        payload_filename: payloadFilename,
        payload_sha256_compressed: pins.sha256_compressed,
        payload_compressed_bytes: pins.compressed_bytes,
        payload_uncompressed_bytes: pins.uncompressed_bytes,
        payload_sha256_uncompressed: pins.sha256_uncompressed,
        expected_row_count: pins.records != null ? pins.records : expectedRowCount,
        payload_schema_version: null, // not present in the producer per-payload schema; NOT fabricated
        // ---- snapshot + execution identity ----
        snapshot_id: seal.snapshot_id,
        production_run_id: seal.production_run_id,
        producer_contract_version: PRODUCER_CONTRACT_VERSION,
        created_by_workflow_run: provenance.workflow_run ?? null,
        created_from_runner_sha: provenance.runner_sha ?? null,
        created_from_workflow_sha: provenance.workflow_sha ?? null,
    };
}
