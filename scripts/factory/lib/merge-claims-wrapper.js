/**
 * Lane 3 claim integrity: the compound-axis merge strategy.
 *
 * COMPOSE, DO NOT MODIFY. deepMergeCompound is called FIRST and is never
 * edited (aggregated-deep-merge.js carries a zero-diff guarantee); every
 * claim decision is then taken on the record it returned, touching ONLY the
 * six frozen top-level keys. Winner invariance is STRUCTURAL, not merely
 * tested.
 *
 * OBJECTIVE: preserve cross-cycle conflicting values -- NOT "attribute each
 * value to the source that supplied it". The merge here is cross-CYCLE, not
 * cross-source: both sides are the same multi-source pipeline at two points
 * in time. Compound axis only; the drug-label axis and the seven
 * strategy-less files stay out of scope for schema v1.0, so the public
 * statement that competing-claim preservation is not yet implemented remains
 * true once this diff is applied in the composition tree.
 *
 * The E-1 split, the reason there are two containers: inchi_key and
 * smiles_canonical are in STRUCTURAL_PRESERVE_FIELDS, so the winner IS the
 * previous value -> preserved_against_null. molecular_formula and iupac_name
 * are in neither preserve list, so the blind spread lets an incoming null win
 * and the previous value is destroyed -> competing_claims, and it MUST NOT be
 * called preserved.
 */

import { deepMergeCompound } from './aggregated-deep-merge.js';
import {
    CLAIMABLE_PATHS, CLAIM_SET_INCOMPLETE_OVERFLOW, byDedupKey, canonicalEqual,
    compareStrings, dedupKey, hasNonFinite, hasOwn, isEmptyValue, makeSourceRef,
    mergeClaimSide, unionDedup,
} from './merge-claims-canonical.js';
import {
    revalidatePrevClaims, revalidateRecord, setOrDelete, validOverflowCounts,
} from './merge-claims-revalidate.js';

// Re-exported so aggregated-merger.js needs exactly ONE new import line.
export { revalidatePrevClaims };

// The per-field cap counts that path's competing_claims AND
// preserved_against_null entries TOGETHER; the per-record cap counts both
// containers across all paths.
export const MAX_ITEMS_PER_FIELD = 8;
export const MAX_ITEMS_PER_RECORD = 32;
const MAX_SAMPLES = 10;

export function makeClaimsCounters() {
    return {
        records: 0, claims_kept: 0, preserved_kept: 0, revalidate_drops: 0,
        nonfinite_rejected: 0, overflow_refusals: 0, overflow_records: 0, sample: [],
    };
}

// All new counters live in ONE `claims` sub-object attached to the deep-merge
// counters, so the caller's stats block grows by one line regardless of how
// many counters the design needs.
function claimsSink(counters) {
    if (counters === null || typeof counters !== 'object') return makeClaimsCounters();
    if (!counters.claims) counters.claims = makeClaimsCounters();
    return counters.claims;
}

// Candidate gate for competing_claims, in this order: the path resolves
// present ON THAT SIDE as an own property; the value is not empty; no
// non-finite number anywhere in it. (Equal-to-winner and dedup are applied
// later, as the frozen steps 5 and 6.)
function newClaimCandidates(prev, current, sink) {
    const out = [];
    for (const path of CLAIMABLE_PATHS) {
        for (const [side, rec] of [['previous', prev], ['incoming', current]]) {
            if (!hasOwn(rec, path)) continue;
            const value = rec[path];
            if (isEmptyValue(value)) continue;
            if (hasNonFinite(value)) { sink.nonfinite_rejected++; continue; }
            out.push({ path, value, side, source: makeSourceRef() });
        }
    }
    return out;
}

// The gate for preserved_against_null is 3b's FOUR conditions and nothing
// else. Condition 4 is what makes the field mean what its name says. A
// MISSING incoming path is never a preservation event -- the underlying
// merge's own preserve branch does fire on a missing key, but that is a
// property of the code, not a licence to record a broader event.
function newPreservedCandidates(prev, current, winner) {
    const out = [];
    for (const path of CLAIMABLE_PATHS) {
        if (!hasOwn(prev, path)) continue;
        const value = prev[path];
        if (isEmptyValue(value) || hasNonFinite(value)) continue;
        if (!hasOwn(current, path)) continue;
        if (!isEmptyValue(current[path])) continue;
        if (!hasOwn(winner, path) || !canonicalEqual(winner[path], value)) continue;
        out.push({ path, value });
    }
    return out;
}

// 3i admission is SKIP-AND-CONTINUE, never stop-at-first-refusal: a refusal
// on one path must not block an admission on another. Never throw, never
// process.exit, never silently truncate -- the stage-3 driver converts any
// throw from the merge into a process exit, so one record at cap would halt
// the whole cycle for every compound, every cycle.
function admit(claimMap, presMap, inhClaims, inhPres) {
    const perField = new Map();
    const refused = new Map();
    const keptClaims = [];
    const keptPreserved = [];
    let total = 0;
    const rows = [
        ...[...claimMap].map(([key, entry]) => ({ key, entry, kind: 'c', out: keptClaims, inherited: inhClaims.has(key) })),
        ...[...presMap].map(([key, entry]) => ({ key, entry, kind: 'p', out: keptPreserved, inherited: inhPres.has(key) })),
    ].sort((a, b) => compareStrings(a.key, b.key) || compareStrings(a.kind, b.kind));
    const take = (row) => {
        row.out.push(row.entry);
        perField.set(row.entry.path, (perField.get(row.entry.path) || 0) + 1);
        total++;
    };
    for (const row of rows) if (row.inherited) take(row);
    for (const row of rows) {
        if (row.inherited) continue;
        const path = row.entry.path;
        if (total >= MAX_ITEMS_PER_RECORD || (perField.get(path) || 0) >= MAX_ITEMS_PER_FIELD) {
            refused.set(path, (refused.get(path) || 0) + 1);
            continue;
        }
        take(row);
    }
    keptClaims.sort(byDedupKey);
    keptPreserved.sort(byDedupKey);
    return { keptClaims, keptPreserved, refused };
}

// 3d.3, the single rule: a field_sources entry exists ONLY alongside a
// retained competing_claims path, plus any pre-existing entry that survives
// re-validation. Not a map over every field, not a map over every winning
// path, and NEVER written for a preserved_against_null path.
function buildFieldSources(prevMap, curMap, keptClaims) {
    const paths = new Set([...Object.keys(prevMap), ...Object.keys(curMap)]);
    for (const e of keptClaims) paths.add(e.path);
    const out = {};
    for (const p of [...paths].sort(compareStrings)) out[p] = makeSourceRef();
    return out;
}

/**
 * F-1, FROZEN: union for the field list, per-path MAX for the counts. The
 * counts mean "maximum observed refusal count in ANY ONE merge" -- monotonic
 * lower-bound evidence, NOT a lifetime total. Neither overwrite nor sum.
 *
 * Exported because the frozen L3-1 discriminating cases (inherited 3 /
 * current 2 and inherited 2 / current 3 on the SAME path) cannot be reached
 * end to end: under schema v1.0 all four paths are top-level scalars, so the
 * winner is always one of the two sides' own values and at most ONE new
 * candidate per path survives the equal-to-winner filter. A single merge can
 * therefore refuse at most one item per path, and the frozen numbers are
 * exercised against this rule directly.
 */
export function composeOverflow(inherited, refused) {
    const fields = [...new Set([...inherited.keys(), ...refused.keys()])].sort(compareStrings);
    const counts = {};
    for (const p of fields) counts[p] = Math.max(inherited.get(p) || 0, refused.get(p) || 0);
    return { fields, counts };
}

// The inherited side is the MAX across BOTH inputs: a cross-cycle merge can
// carry inherited state on either side and a count may never be lowered.
function applyOverflow(merged, prev, current, refused) {
    const inherited = new Map();
    for (const rec of [prev, current]) {
        for (const [p, n] of validOverflowCounts(rec)) {
            if ((inherited.get(p) || 0) < n) inherited.set(p, n);
        }
    }
    const { fields, counts } = composeOverflow(inherited, refused);
    const sticky = prev.claim_set_state === CLAIM_SET_INCOMPLETE_OVERFLOW
        || current.claim_set_state === CLAIM_SET_INCOMPLETE_OVERFLOW;
    if (fields.length === 0) {
        if (sticky) merged.claim_set_state = CLAIM_SET_INCOMPLETE_OVERFLOW;
        else delete merged.claim_set_state;
        delete merged.claim_overflow_fields;
        delete merged.claim_overflow_counts;
        return;
    }
    merged.claim_set_state = CLAIM_SET_INCOMPLETE_OVERFLOW;
    merged.claim_overflow_fields = fields;
    merged.claim_overflow_counts = counts;
}

export function mergeCompoundWithClaims(prev, current, counters) {
    // 4b aliasing: when either side is absent the underlying merge returns
    // the OTHER INPUT BY IDENTITY. Attach nothing; return exactly that.
    if (!prev || !current) return deepMergeCompound(prev, current, counters);
    const merged = deepMergeCompound(prev, current, counters);
    const sink = claimsSink(counters);
    sink.records++;

    const ctx = { dropped: 0 };
    const pv = revalidateRecord(prev, ctx);
    const cv = revalidateRecord(current, ctx);
    sink.revalidate_drops += ctx.dropped;

    const claimMap = unionDedup([...pv.claims, ...cv.claims], mergeClaimSide);
    const presMap = unionDedup([...pv.preserved, ...cv.preserved], () => {});
    const inhClaims = new Set(claimMap.keys());
    const inhPres = new Set(presMap.keys());
    for (const e of newClaimCandidates(prev, current, sink)) {
        const k = dedupKey(e.path, e.value);
        const prior = claimMap.get(k);
        if (prior) mergeClaimSide(prior, e);
        else claimMap.set(k, e);
    }
    for (const e of newPreservedCandidates(prev, current, merged)) {
        const k = dedupKey(e.path, e.value);
        if (!presMap.has(k)) presMap.set(k, e);
    }

    // Step 6: the equal-to-winner filter applies to competing_claims ONLY,
    // and MUST NEVER delete a preserved_against_null entry -- for the two
    // structural paths the preserved value ALWAYS equals the winner.
    for (const [k, e] of [...claimMap]) {
        if (hasOwn(merged, e.path) && canonicalEqual(e.value, merged[e.path])) claimMap.delete(k);
    }

    const { keptClaims, keptPreserved, refused } = admit(claimMap, presMap, inhClaims, inhPres);
    sink.claims_kept += keptClaims.length;
    sink.preserved_kept += keptPreserved.length;
    let refusedTotal = 0;
    for (const n of refused.values()) refusedTotal += n;
    if (refusedTotal > 0) {
        sink.overflow_refusals += refusedTotal;
        sink.overflow_records++;
        for (const path of [...refused.keys()].sort(compareStrings)) {
            // A sample is a record id plus an allow-listed path. NO VALUE.
            if (sink.sample.length < MAX_SAMPLES) sink.sample.push({ id: merged.id, path });
        }
    }

    setOrDelete(merged, 'competing_claims', keptClaims);
    setOrDelete(merged, 'preserved_against_null', keptPreserved);
    const fieldSources = buildFieldSources(pv.fieldSources, cv.fieldSources, keptClaims);
    if (Object.keys(fieldSources).length > 0) merged.field_sources = fieldSources;
    else delete merged.field_sources;
    applyOverflow(merged, prev, current, refused);
    return merged;
}
