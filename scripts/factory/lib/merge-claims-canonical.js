/**
 * Lane 3 claim integrity: canonicalisation, equality and the frozen
 * vocabulary shared by the merge wrapper and the re-validation pass.
 *
 * PRIVATE re-implementation of the repository canonicalisation. The named
 * reference is scripts/factory/lib/snapshot-identity.js -> canonicalize
 * (recursive sorted-key, array-order-preserving, compact). It is NOT
 * imported here: that module imports @aws-sdk/client-s3, which would be
 * dragged into the merge path and into every unit test. Byte-for-byte
 * parity with the reference is asserted by
 * tests/factory/merge-claims-canonical-parity.test.ts, the only place the
 * reference may be imported.
 *
 * Frozen equality rulings (schema v1.0):
 *   strings                 case- and whitespace-sensitive; no trimming,
 *                           no Unicode normalisation
 *   1 vs 1.0                equal
 *   180.16 vs 180.157       NOT equal -- no epsilon, no rounding
 *   -0 vs 0                 equal
 *   non-finite numbers      rejected, never stored: canonicalisation maps
 *                           them to null, which would collide with a real
 *                           null. Rejected if one appears ANYWHERE in the
 *                           value tree, not only at the root.
 *   undefined / null / missing   distinguished BEFORE canonicalisation
 */

// The four claimable paths, closed (LANE3 3a). All top-level scalars in
// schema v1.0: no dotted paths, no nested containers, no array-valued
// paths. Path resolution is a plain own-property lookup; a missing key
// resolves to MISSING, which is distinct from null.
// Excluded and closed: `id` (a claim on the identity key asserts that two
// records are one record) and `pubchem_cid` (identity use, Founder ruling).
export const CLAIMABLE_PATHS = Object.freeze([
    'inchi_key',
    'smiles_canonical',
    'molecular_formula',
    'iupac_name',
]);

const CLAIMABLE_SET = new Set(CLAIMABLE_PATHS);

export const CLAIM_SET_INCOMPLETE_OVERFLOW = 'CLAIM_SET_INCOMPLETE_OVERFLOW';

// Dedup separator: path + SEP + canonical(value). Written as an ESCAPE and
// never as a literal NUL byte -- a literal would fail the byte audit. The
// character cannot occur in JSON-escaped text, so the join is unambiguous.
const DEDUP_SEP = '\u0000';

export function hasOwn(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

export function isClaimablePath(p) {
    return typeof p === 'string' && CLAIMABLE_SET.has(p);
}

/**
 * Canonical serialisation: keys sorted recursively, array order preserved
 * (array order is meaningful), compact separators, undefined folded to
 * null. Parity target: snapshot-identity.js -> canonicalize.
 */
export function canonicalize(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        const body = keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',');
        return `{${body}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

/** True when a non-finite number appears ANYWHERE in the value tree. */
export function hasNonFinite(value) {
    if (typeof value === 'number') return !Number.isFinite(value);
    if (Array.isArray(value)) return value.some(hasNonFinite);
    if (value && typeof value === 'object') return Object.values(value).some(hasNonFinite);
    return false;
}

/** Empty for claim purposes: null, an explicit undefined, or the empty string. */
export function isEmptyValue(v) {
    return v === null || v === undefined || v === '';
}

/**
 * The 3g legality gate, applied to a candidate value AND to an inherited
 * entry's value during re-validation: a stored claim value is never empty
 * (the candidate gate refuses empties at creation) and never carries a
 * non-finite number.
 */
export function isLegalValue(v) {
    return !isEmptyValue(v) && !hasNonFinite(v);
}

export function canonicalEqual(a, b) {
    return canonicalize(a) === canonicalize(b);
}

export function dedupKey(path, value) {
    return `${path}${DEDUP_SEP}${canonicalize(value)}`;
}

/** Locale-free ascending comparator. Never String.prototype.localeCompare. */
export function compareStrings(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * The only SourceRef form in schema v1.0. At this integration point the
 * merge is cross-CYCLE, not cross-source: both sides are the same
 * multi-source pipeline at two points in time, so for the four frozen
 * paths there is no field-level source at all. The `status: "known"`
 * branch is dead code in v1.0 and is deliberately never written. Inferring
 * a source from container- or record-level provenance is FORBIDDEN.
 */
export function makeSourceRef() {
    return { source: null, status: 'unknown' };
}

export function isSourceRef(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
        && Object.keys(v).length === 2
        && v.source === null && v.status === 'unknown';
}

/**
 * Claim shape: exactly { path, value, side, source }.
 *
 * `Preserved` carries NO `side`: every preservation preserves the PREVIOUS
 * side's value, so a `side` field would be a constant. Do not "fix" one in.
 */
export function isClaimShape(e) {
    return e !== null && typeof e === 'object' && !Array.isArray(e)
        && Object.keys(e).length === 4
        && isClaimablePath(e.path)
        && hasOwn(e, 'value')
        && (e.side === 'previous' || e.side === 'incoming')
        && isSourceRef(e.source);
}

export function isPreservedShape(e) {
    return e !== null && typeof e === 'object' && !Array.isArray(e)
        && Object.keys(e).length === 2
        && isClaimablePath(e.path)
        && hasOwn(e, 'value');
}

export function isPositiveInteger(n) {
    return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

/**
 * Dedup, ordering and collision helpers over { path, value } claim entries.
 * They live in this module rather than in the wrapper because they are pure
 * functions of the dedup key and the locale-free comparator defined above,
 * and because every Lane 3 module must stay under the 250-line CES cap.
 */
export function byDedupKey(a, b) {
    return compareStrings(dedupKey(a.path, a.value), dedupKey(b.path, b.value));
}

// Field-wise collision merge, NOT first-write-wins: side is "previous" if
// EITHER colliding entry is "previous"; source is always the one v1.0 form.
export function mergeClaimSide(prior, e) {
    if (e.side === 'previous') prior.side = 'previous';
}

/**
 * Two claims are the SAME claim if and only if they assert the same value
 * for the same path: `side` and `source` are NOT part of the key.
 */
export function unionDedup(entries, collide) {
    const map = new Map();
    for (const e of entries) {
        const k = dedupKey(e.path, e.value);
        const prior = map.get(k);
        if (prior) collide(prior, e);
        else map.set(k, e);
    }
    return map;
}
