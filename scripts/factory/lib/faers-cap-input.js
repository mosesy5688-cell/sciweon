/**
 * P-8R1 F3 cap-input validation helper.
 *
 * ===== WHY THIS EXISTS =====
 * The P-8 recovery drain (lib/drain-adapter-backlog.js -> parseMaxRecordsEnv)
 * already honors the env var FAERS_BACKFILL_MAX_RECORDS as a per-run FAERS
 * record cap. But factory-3-aggregate.yml did NOT expose any way to SET that
 * env from a dispatch -- it only had `backfill_only`. So a P-8R1 BOUNDED (e.g.
 * 8000-record) recovery backfill could not be triggered.
 *
 * This helper is the SINGLE validation chokepoint the workflow's guard step
 * calls. It resolves the dispatch input `faers_max_records` into either:
 *   - a canonical positive-integer STRING (the value to export as
 *     FAERS_BACKFILL_MAX_RECORDS), or
 *   - `null` (meaning: do NOT set the env -> UNBOUNDED = normal behavior).
 * It THROWS (fail-loud) on any contract violation so a malformed/misused cap
 * never silently degrades to 0 (a 0 cap would stamp NOTHING) or leaks into the
 * normal full F3 path.
 *
 * ===== CONTRACT (see requirements) =====
 *  1. eventName !== 'workflow_dispatch'  (the workflow_run AUTO cascade path)
 *     -> ALWAYS return null. workflow_run carries no inputs, but be defensive:
 *        never inherit a cap on the scheduled path regardless of any value.
 *  2. faersMaxRecords empty / undefined / null / whitespace-only
 *     -> return null (unbounded). Do NOT coerce '' -> 0.
 *  3. faersMaxRecords non-empty BUT backfillOnly !== 'true'
 *     -> THROW. A cap only makes sense for the isolated backfill drain.
 *  4. faersMaxRecords non-empty: must be a POSITIVE INTEGER. Trim, then accept
 *     ONLY /^[0-9]+$/ with value >= 1. Reject 0, negatives, decimals (8000.5),
 *     NaN, non-numeric, '+8000', '8e3', '0x1f4'. Return the canonical integer
 *     string (no leading zeros, e.g. '8000').
 *
 * Pure + side-effect-free (no process.env reads, no I/O) -> fully unit-testable.
 */

/**
 * @param {object} args
 * @param {string} [args.eventName]        github.event_name
 * @param {string} [args.backfillOnly]     inputs.backfill_only ('true'/'false')
 * @param {string} [args.faersMaxRecords]  inputs.faers_max_records (raw string)
 * @returns {string|null} canonical positive-integer string, or null (no cap)
 * @throws {Error} on a contract violation (fail-loud)
 */
export function resolveFaersMaxRecords({ eventName, backfillOnly, faersMaxRecords } = {}) {
    // Rule 1: the AUTO workflow_run cascade path NEVER inherits a cap. Guard
    // first and unconditionally -- workflow_run carries no inputs, but we refuse
    // to set the env even if some value were somehow present.
    if (eventName !== 'workflow_dispatch') {
        return null;
    }

    // Rule 2: empty / undefined / null / whitespace-only -> unbounded (normal).
    // Explicitly do NOT coerce an empty string to 0.
    if (faersMaxRecords == null) {
        return null;
    }
    if (typeof faersMaxRecords !== 'string') {
        throw new Error(
            `faers_max_records invalid: expected a string, got ${typeof faersMaxRecords}`,
        );
    }
    const trimmed = faersMaxRecords.trim();
    if (trimmed === '') {
        return null;
    }

    // Rule 3: a non-empty cap is only valid on the isolated backfill drain.
    if (backfillOnly !== 'true') {
        throw new Error(
            'faers_max_records requires backfill_only=true ' +
            `(got backfill_only='${backfillOnly == null ? '' : backfillOnly}', ` +
            `faers_max_records='${trimmed}'). A record cap is only meaningful for ` +
            'the P-8R1 isolated FAERS backfill; refusing to cap the normal full F3 path.',
        );
    }

    // Rule 4: strict positive-integer parse. ONLY digits, value >= 1.
    if (!/^[0-9]+$/.test(trimmed)) {
        throw new Error(
            `faers_max_records invalid: '${faersMaxRecords}' is not a positive ` +
            "integer (expected only digits matching /^[0-9]+$/ with value >= 1; " +
            "reject 0, negatives, decimals, '+8000', '8e3', hex, NaN, non-numeric).",
        );
    }
    const value = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(
            `faers_max_records invalid: '${faersMaxRecords}' must be a positive ` +
            'integer >= 1.',
        );
    }

    // Canonical integer string (strips any leading zeros, e.g. '08000' -> '8000').
    return String(value);
}
