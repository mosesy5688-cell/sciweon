/**
 * RK-16C FULL-CORPUS SPIKE (C) — CORPUS-IDENTITY CONTRACT (OFFLINE-safe).
 *
 * Defines + validates the FULL identity envelope a production-scale corpus read
 * is pinned to. NOTHING here performs a network read; it is pure logic the
 * read-only adapter + the matrix runner consume so EVERY corpus-grounded result
 * is bound to one immutable identity and a verified hash/row-count.
 *
 * Candidate snapshot = '2026-06-14/27502029137-1'; expected_row_count = 475112
 * is EXPECTED-ONLY — it becomes VERIFIED only after a real read confirms it
 * against the manifest/hash/count. The validator FAIL-CLOSES on ANY mismatch
 * (identity / hash / schema / row-count) and NEVER auto-switches to latest.
 */

export const CANDIDATE_SNAPSHOT_ID = '2026-06-14/27502029137-1';
export const EXPECTED_ROW_COUNT = 475112;
export const PROJECTION_SCHEMA_VERSION = 'rk16c-bioactivity-proj-v1';

/** The bioactivities full-corpus satellite object for the candidate snapshot. */
export function bioactivitiesObjectKey(snapshotId = CANDIDATE_SNAPSHOT_ID) {
    return `snapshots/${snapshotId}/bioactivities.jsonl.gz`;
}
/** The production latest pointer (identity verification only — never followed). */
export const LATEST_POINTER_KEY = 'snapshots/latest.json';
/** The snapshot root seal (manifest identity verification). */
export function manifestObjectKey(snapshotId = CANDIDATE_SNAPSHOT_ID) {
    return `snapshots/${snapshotId}/_snapshot.manifest.json`;
}

/**
 * The EXACT, exhaustive object allowlist for a corpus identity read. Anything
 * not in this set must NEVER be requested. Order is the read order.
 */
export function consumedObjectKeys(snapshotId = CANDIDATE_SNAPSHOT_ID) {
    return [
        LATEST_POINTER_KEY,            // identity reconciliation (not followed)
        manifestObjectKey(snapshotId), // manifest / seal for hash verification
        bioactivitiesObjectKey(snapshotId), // the full corpus satellite
    ];
}

/**
 * Build a PROPOSED (pre-read) identity envelope: every read-derived field is
 * null until a real read fills it. `expected` overrides defaults for a custom
 * pin. build_commit may be injected (git rev-parse HEAD) by the caller.
 */
export function proposeIdentity(opts = {}) {
    const snapshot_id = opts.snapshot_id || CANDIDATE_SNAPSHOT_ID;
    const expected_row_count =
        opts.expected_row_count != null ? opts.expected_row_count : EXPECTED_ROW_COUNT;
    return {
        snapshot_id,
        snapshot_production_run_id: snapshot_id.split('/')[1] || null,
        manifest_object_key: manifestObjectKey(snapshot_id),
        consumed_object_keys: consumedObjectKeys(snapshot_id),
        object_byte_size: null,         // VERIFIED after HEAD/GET
        etag: null,                     // VERIFIED after HEAD
        sha256: null,                   // VERIFIED after GET (pinned compare)
        schema_version: PROJECTION_SCHEMA_VERSION,
        expected_row_count,             // EXPECTED-ONLY until a read
        observed_row_count: null,       // VERIFIED after count
        build_commit: opts.build_commit || null,
        local_materialization_path: null,
        materialization_timestamp: null,
        verification_status: 'EXPECTED_ONLY',
    };
}

function fail(errors, cond, msg) { if (!cond) errors.push(msg); }

/**
 * Validate a POST-READ identity envelope against the pinned expectation. Returns
 * { valid, verification_status, errors }. FAIL-CLOSES (valid=false) on ANY
 * mismatch. NEVER returns valid for a latest-derived id that differs from pin.
 *
 * @param {object} actual   the envelope filled in after a read
 * @param {object} pinned   { snapshot_id, expected_sha256, expected_row_count,
 *                            expected_object_byte_size?, schema_version? }
 */
export function validateIdentity(actual, pinned) {
    const errors = [];
    fail(errors, actual && typeof actual === 'object', 'identity envelope missing');
    if (!actual) return { valid: false, verification_status: 'INVALID', errors };

    fail(errors, actual.snapshot_id === pinned.snapshot_id,
        `snapshot_id mismatch: pinned=${pinned.snapshot_id} actual=${actual.snapshot_id} (NEVER auto-switch to latest)`);
    fail(errors, actual.sha256 != null, 'sha256 absent (no verified read)');
    if (pinned.expected_sha256 != null) {
        fail(errors, actual.sha256 === pinned.expected_sha256,
            `sha256 mismatch: pinned=${pinned.expected_sha256} actual=${actual.sha256}`);
    }
    fail(errors, actual.observed_row_count != null, 'observed_row_count absent (no verified count)');
    fail(errors, actual.observed_row_count === pinned.expected_row_count,
        `row_count mismatch: expected=${pinned.expected_row_count} observed=${actual.observed_row_count}`);
    const wantSchema = pinned.schema_version || PROJECTION_SCHEMA_VERSION;
    fail(errors, actual.schema_version === wantSchema,
        `schema_version mismatch: expected=${wantSchema} actual=${actual.schema_version}`);
    if (pinned.expected_object_byte_size != null) {
        fail(errors, actual.object_byte_size === pinned.expected_object_byte_size,
            `object_byte_size mismatch: expected=${pinned.expected_object_byte_size} actual=${actual.object_byte_size}`);
    }
    fail(errors, actual.local_materialization_path != null,
        'local_materialization_path absent (nothing materialized)');

    const valid = errors.length === 0;
    return {
        valid,
        verification_status: valid ? 'VERIFIED' : 'INVALID',
        errors,
    };
}

/**
 * Reconcile a parsed latest.json context against the pin WITHOUT following it.
 * If latest != pin we FAIL — we never re-target to whatever latest points at.
 */
export function reconcileLatestVsPin(latestSnapshotId, pinnedSnapshotId) {
    return {
        latest_snapshot_id: latestSnapshotId,
        pinned_snapshot_id: pinnedSnapshotId,
        matches_pin: latestSnapshotId === pinnedSnapshotId,
        note: latestSnapshotId === pinnedSnapshotId
            ? 'latest == pin (informational; the read still targets the PIN)'
            : 'latest != pin — the spike STILL reads the PINNED id; it NEVER follows latest',
    };
}
