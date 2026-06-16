/**
 * RK-16C FULL-CORPUS SPIKE (M3) — versioned, CREDENTIAL-FREE integrity LOCK.
 *
 * The lock is the ONLY thing the full-corpus `--execute` run accepts. It carries
 * the mandatory integrity pins (etag + byte size + sha256 for BOTH the manifest
 * and the payload) plus identity (snapshot_id, production_run_id, expected row
 * count, schema_version). It is POPULATED by the founder-gated METADATA-ONLY
 * PREFLIGHT (which HEAD/GETs the small manifest and reads the payload pins FROM
 * THE MANIFEST BODY) and founder-reviewed — it is NEVER fabricated and NEVER
 * self-proved in the BUILD phase. NO credentials appear anywhere in the lock.
 *
 * The full run loads + require()s a COMPLETE lock BEFORE any payload GET; a
 * missing lock or any null/empty required field FAILS BEFORE NETWORK (throws
 * before any client call). There is no "just --snapshot then discover" path.
 */

import fs from 'fs';

// D-103 candidate-lock v2 (A1 two-manifest trust anchor). The root seal does NOT
// reference manifest.json, so the lock records the trust model EXPLICITLY and must
// NEVER claim direct cryptographic root linkage.
export const LOCK_SCHEMA_VERSION = 'rk16c-fullcorpus-lock-v2';
export const TRUST_ANCHOR_MODE = 'producer-contract-derived-sibling-v1';
export const LOCK_FILE_NAME = 'RK16C_FULLCORPUS_LOCK.json';

/**
 * Every INTEGRITY/IDENTITY field REQUIRED in a complete lock before any payload
 * read may occur. (Provenance — created_by_workflow_run / created_from_runner_sha
 * / created_from_workflow_sha — is recorded but null in offline/fake contexts, so
 * it is NOT gated here.) NO credentials are permitted anywhere in a lock.
 */
export const REQUIRED_LOCK_FIELDS = Object.freeze([
    // trust-anchor model
    'trust_anchor_mode',
    'file_manifest_key_derivation',
    'payload_membership_anchor',
    'file_manifest_admissibility_anchor',
    // root-manifest (seal) identity
    'root_manifest_key',
    'root_manifest_etag',
    'root_manifest_byte_size',
    'root_manifest_sha256',
    'root_manifest_stored_hash',
    'root_manifest_recomputed_hash',
    // per-file manifest identity
    'file_manifest_key',
    'file_manifest_etag',
    'file_manifest_byte_size',
    'file_manifest_sha256',
    'file_manifest_schema_version',
    // payload identity
    'payload_key',
    'payload_filename',
    'payload_sha256_compressed',
    'payload_compressed_bytes',
    'expected_row_count',
    // snapshot + execution identity
    'snapshot_id',
    'production_run_id',
    'producer_contract_version',
    'candidate_lock_schema',
]);

/** SHA-256 hex fields that must match /^[0-9a-f]{64}$/ when present. */
const SHA256_FIELDS = Object.freeze([
    'root_manifest_sha256', 'root_manifest_stored_hash', 'root_manifest_recomputed_hash',
    'file_manifest_sha256', 'payload_sha256_compressed',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Field names that must NEVER appear in a lock (it is credential-free). */
const FORBIDDEN_CREDENTIAL_FIELDS = Object.freeze([
    'access_key_id', 'secret_access_key', 'session_token', 'credentials',
    'account_id', 'endpoint', 'r2_access_key_id', 'r2_secret_access_key',
]);

function isNonEmpty(v) {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'number') return Number.isFinite(v);
    return false;
}

function isPositiveInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Validate a lock object. Returns { ok, errors[] }. Every missing/empty required
 * field is reported; byte-size + row-count must be positive integers; any
 * credential-shaped field is rejected. Pure, non-throwing.
 */
export function validateLock(lock) {
    const errors = [];
    if (lock == null || typeof lock !== 'object' || Array.isArray(lock)) {
        return { ok: false, errors: ['lock must be a non-null object'] };
    }
    for (const field of REQUIRED_LOCK_FIELDS) {
        if (!(field in lock) || !isNonEmpty(lock[field])) {
            errors.push(`required lock field missing/empty: ${field}`);
        }
    }
    for (const intField of ['root_manifest_byte_size', 'file_manifest_byte_size', 'payload_compressed_bytes', 'expected_row_count']) {
        if (intField in lock && lock[intField] != null && !isPositiveInt(lock[intField])) {
            errors.push(`lock field ${intField} must be a positive integer`);
        }
    }
    for (const shaField of SHA256_FIELDS) {
        if (shaField in lock && lock[shaField] != null && !SHA256_RE.test(String(lock[shaField]))) {
            errors.push(`lock field ${shaField} must be a 64-hex sha256`);
        }
    }
    if ('candidate_lock_schema' in lock && lock.candidate_lock_schema != null
        && lock.candidate_lock_schema !== LOCK_SCHEMA_VERSION) {
        errors.push(`lock candidate_lock_schema must be "${LOCK_SCHEMA_VERSION}" (got ${lock.candidate_lock_schema})`);
    }
    if ('trust_anchor_mode' in lock && lock.trust_anchor_mode != null
        && lock.trust_anchor_mode !== TRUST_ANCHOR_MODE) {
        errors.push(`lock trust_anchor_mode must be "${TRUST_ANCHOR_MODE}" (got ${lock.trust_anchor_mode})`);
    }
    // A1 honesty invariant: the seal does NOT cryptographically reference the
    // per-file manifest. The lock MUST carry root_directly_references_file_manifest
    // === false and MUST NOT claim direct root linkage.
    if (!('root_directly_references_file_manifest' in lock)) {
        errors.push('lock must record root_directly_references_file_manifest (=false)');
    } else if (lock.root_directly_references_file_manifest !== false) {
        errors.push('lock root_directly_references_file_manifest must be exactly false (A1 is NOT direct cryptographic root linkage)');
    }
    for (const cred of FORBIDDEN_CREDENTIAL_FIELDS) {
        if (cred in lock) errors.push(`lock must be credential-free: forbidden field ${cred}`);
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Require a COMPLETE lock. THROWS listing every missing/empty field. This is the
 * fail-before-network gate: callers must invoke it BEFORE making any client.
 */
export function requireLock(lock) {
    const { ok, errors } = validateLock(lock);
    if (!ok) {
        throw new Error(
            '[rk16c-lock] incomplete/invalid full-corpus lock — FAIL BEFORE NETWORK '
            + '(no payload GET may occur until the founder-gated preflight populates '
            + 'a complete lock):\n  - ' + errors.join('\n  - '),
        );
    }
    return lock;
}

/** Load + parse a lock file from disk. THROWS if absent or unparseable. */
export function loadLockFile(lockPath) {
    if (!lockPath) {
        throw new Error('[rk16c-lock] no --lock path supplied — FAIL BEFORE NETWORK '
            + '(the --execute full run accepts ONLY a complete founder-reviewed lock)');
    }
    if (!fs.existsSync(lockPath)) {
        throw new Error(`[rk16c-lock] lock file not found at ${lockPath} — FAIL BEFORE NETWORK `
            + '(a real lock is populated by the founder-gated metadata-only preflight, never fabricated)');
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch (err) {
        throw new Error(`[rk16c-lock] lock file at ${lockPath} is not valid JSON: ${err?.message ?? err}`);
    }
    return parsed;
}

/** Load + require() a complete lock from disk in one call (fail-before-network). */
export function loadAndRequireLock(lockPath) {
    return requireLock(loadLockFile(lockPath));
}
