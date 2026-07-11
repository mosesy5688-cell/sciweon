/**
 * RC-3B-P0B READ-ONLY R2 AUDIT HARNESS -- immutable caps.
 *
 * These caps are HARD CONSTANTS. A run plan may LOWER any cap but MUST NOT
 * raise it. resolveCaps() takes the element-wise MINIMUM of the immutable cap
 * and any plan-supplied cap, so a plan can only tighten. A plan that asks for a
 * HIGHER cap is rejected by the run-manifest validator (fail-closed) -- this
 * module never lets an effective cap exceed the immutable ceiling.
 *
 * When any cap is reached at runtime the run STOPS (partial); no further
 * network call is made (enforced by the Budget + the command guard).
 */

export const IMMUTABLE_CAPS = Object.freeze({
    MAX_LIST_KEYS_PER_RUN: 5000,
    MAX_LIST_PAGES_PER_RUN: 10,
    MAX_OBJECTS_TOUCHED_PER_RUN: 1000,
    MAX_HEAD_REQUESTS_PER_RUN: 1000,
    MAX_GET_META_REQUESTS_PER_RUN: 128,
    MAX_RANGE_REQUESTS_PER_RUN: 128,
    MAX_BYTES_TOTAL_PER_RUN: 67108864,
    MAX_GET_META_OBJECT_BYTES: 1048576,
    MAX_GET_META_TOTAL_BYTES: 16777216,
    MAX_SINGLE_RANGE_BYTES: 65536,
    MAX_DECODED_BYTES_PER_SAMPLE: 262144,
    MAX_RUNTIME_SECONDS: 1200,
});

export const CAP_NAMES = Object.freeze(Object.keys(IMMUTABLE_CAPS));

/**
 * Effective caps = element-wise min(immutable, plan). A plan value that is
 * missing, non-numeric, or higher than the immutable ceiling never raises the
 * effective cap: it is clamped down to the immutable value.
 *
 * @param {object} planCaps  optional per-cap overrides from the run plan
 * @returns {object} frozen effective caps (each <= immutable)
 */
export function resolveCaps(planCaps = {}) {
    const out = {};
    for (const name of CAP_NAMES) {
        const ceiling = IMMUTABLE_CAPS[name];
        const requested = planCaps[name];
        if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0) {
            out[name] = Math.min(ceiling, requested);
        } else {
            out[name] = ceiling;
        }
    }
    return Object.freeze(out);
}

/**
 * List every plan cap that VIOLATES the "lower-not-higher" rule (asks for more
 * than the immutable ceiling, or is a non-finite/negative number). Used by the
 * run-manifest validator to reject a plan BEFORE any network activity.
 *
 * @param {object} planCaps
 * @returns {string[]} names of offending caps (empty => all in bounds)
 */
export function capViolations(planCaps = {}) {
    const bad = [];
    for (const [name, requested] of Object.entries(planCaps)) {
        if (!CAP_NAMES.includes(name)) { bad.push(`${name}:unknown-cap`); continue; }
        if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) {
            bad.push(`${name}:not-a-nonnegative-number`);
            continue;
        }
        if (requested > IMMUTABLE_CAPS[name]) {
            bad.push(`${name}:exceeds-immutable-ceiling(${requested}>${IMMUTABLE_CAPS[name]})`);
        }
    }
    return bad;
}
