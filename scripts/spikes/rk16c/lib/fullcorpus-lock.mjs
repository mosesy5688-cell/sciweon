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

export const LOCK_SCHEMA_VERSION = 'rk16c-fullcorpus-lock-v1';
export const LOCK_FILE_NAME = 'RK16C_FULLCORPUS_LOCK.json';

/** Every field REQUIRED in a complete lock. NO credentials are permitted here. */
export const REQUIRED_LOCK_FIELDS = Object.freeze([
    'snapshot_id',
    'production_run_id',
    'manifest_key',
    'manifest_etag',
    'manifest_byte_size',
    'manifest_sha256',
    'payload_key',
    'payload_etag',
    'payload_byte_size',
    'payload_sha256',
    'expected_row_count',
    'schema_version',
]);

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
    for (const intField of ['manifest_byte_size', 'payload_byte_size', 'expected_row_count']) {
        if (intField in lock && lock[intField] != null && !isPositiveInt(lock[intField])) {
            errors.push(`lock field ${intField} must be a positive integer`);
        }
    }
    if ('schema_version' in lock && lock.schema_version != null
        && lock.schema_version !== LOCK_SCHEMA_VERSION) {
        errors.push(`lock schema_version must be "${LOCK_SCHEMA_VERSION}" (got ${lock.schema_version})`);
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
