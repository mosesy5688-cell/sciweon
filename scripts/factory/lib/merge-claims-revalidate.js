/**
 * Lane 3 claim integrity: re-validation of INHERITED claim entries, plus
 * the prev-load-boundary pass (LANE3 3h / 3j).
 *
 * Why a boundary pass exists at all: the merge strategy function runs ONLY
 * on the intersection of the previous and current record sets, and at
 * cumulative scale most records are prev-only. A re-validation guarantee
 * that lived only inside the strategy would therefore be structurally
 * unreachable for most records -- this repository already suffered exactly
 * that failure (28,097 prev-only records silently skipped in PR-FDA-SRS-3)
 * and fixed it with a prev-load-boundary pass. Without one, a single bad
 * inherited entry propagates forever and any future narrowing of the
 * allow-list is silently defeated.
 */

import {
    compareStrings, dedupKey, hasOwn, isClaimShape, isClaimablePath,
    isLegalValue, isPositiveInteger, isPreservedShape, isSourceRef,
    makeSourceRef,
} from './merge-claims-canonical.js';

const CONTAINER_KEYS = Object.freeze([
    'competing_claims', 'preserved_against_null', 'field_sources',
]);

const MAX_SAMPLES = 10;

function revalidateEntries(list, isShape, normalize, ctx) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) { ctx.dropped++; return []; }
    const out = [];
    const seen = new Set();
    for (const e of list) {
        if (!isShape(e) || !isLegalValue(e.value)) { ctx.dropped++; continue; }
        const k = dedupKey(e.path, e.value);
        if (seen.has(k)) { ctx.dropped++; continue; }
        seen.add(k);
        out.push(normalize(e));
    }
    return out;
}

/**
 * Inherited competing_claims: drop any entry whose path is not on the
 * current allow-list, whose shape does not match Claim, or whose value
 * fails the legality gate; then dedup. Survivors are rebuilt in a fixed
 * key order so a re-merge is byte-identical.
 */
export function revalidateClaims(list, ctx) {
    return revalidateEntries(list, isClaimShape, e => ({
        path: e.path, value: e.value, side: e.side, source: makeSourceRef(),
    }), ctx);
}

/**
 * Inherited preserved_against_null: shape, allow-list, legality and dedup
 * ONLY. These entries record historically-occurred events, so they are
 * NEVER re-derived against today's winner (LANE3 3b).
 */
export function revalidatePreserved(list, ctx) {
    return revalidateEntries(list, isPreservedShape, e => ({
        path: e.path, value: e.value,
    }), ctx);
}

/** Inherited field_sources: allow-listed path -> the one v1.0 SourceRef form. */
export function revalidateFieldSources(map, ctx) {
    if (map === undefined) return {};
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
        ctx.dropped++;
        return {};
    }
    const out = {};
    for (const p of Object.keys(map).sort(compareStrings)) {
        if (!isClaimablePath(p) || !isSourceRef(map[p])) { ctx.dropped++; continue; }
        out[p] = makeSourceRef();
    }
    return out;
}

/**
 * VALID INHERITED overflow counts (F-1, frozen): an inherited entry is
 * valid if and only if it is a POSITIVE INTEGER entry on an allow-listed
 * path that passes the structural validation. An entry that is already
 * valid MAY NOT be deleted by a later re-validation pass.
 */
export function validOverflowCounts(rec) {
    const out = new Map();
    const counts = rec == null ? undefined : rec.claim_overflow_counts;
    if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return out;
    for (const p of Object.keys(counts)) {
        if (isClaimablePath(p) && isPositiveInteger(counts[p])) out.set(p, counts[p]);
    }
    return out;
}

export function revalidateRecord(rec, ctx) {
    return {
        claims: revalidateClaims(rec == null ? undefined : rec.competing_claims, ctx),
        preserved: revalidatePreserved(rec == null ? undefined : rec.preserved_against_null, ctx),
        fieldSources: revalidateFieldSources(rec == null ? undefined : rec.field_sources, ctx),
    };
}

/**
 * LANE3 3h step 9: attach a non-empty container, and DELETE the inherited
 * key when the computed set is now empty. "Absent, not empty" -- no key is
 * written when there is nothing to say, and `[]` is never emitted.
 */
export function setOrDelete(rec, key, list) {
    if (list.length > 0) rec[key] = list;
    else delete rec[key];
}

function applyInPlace(rec, ctx) {
    if (rec === null || typeof rec !== 'object') return;
    if (!CONTAINER_KEYS.some(k => hasOwn(rec, k))) return;
    const v = revalidateRecord(rec, ctx);
    setOrDelete(rec, 'competing_claims', v.claims);
    setOrDelete(rec, 'preserved_against_null', v.preserved);
    if (Object.keys(v.fieldSources).length > 0) rec.field_sources = v.fieldSources;
    else delete rec.field_sources;
}

/**
 * LANE3 3j: the prev-load-boundary re-validation pass. Mirrors the
 * existing bootstrapPrevRecords pass -- a separate, O(N), in-place pass
 * over the FULL previous record list, run in aggregated-merger.js and NOT
 * inside deepMergeCompound.
 *
 * It performs ONLY the 3h re-validation (shape, allow-list, legality,
 * dedup). It never creates, modifies or deletes a winner; it never creates
 * a container key that was absent; and it never touches the three sticky
 * overflow keys, so a valid inherited overflow entry cannot be removed by
 * this pass.
 */
export function revalidatePrevClaims(prevRecords) {
    if (!Array.isArray(prevRecords)) {
        return { scanned: 0, dropped: 0, records_cleaned: 0, sample: [] };
    }
    const ctx = { dropped: 0 };
    let cleaned = 0;
    const sample = [];
    for (const rec of prevRecords) {
        const before = ctx.dropped;
        applyInPlace(rec, ctx);
        if (ctx.dropped > before) {
            cleaned++;
            if (sample.length < MAX_SAMPLES) sample.push(rec == null ? null : rec.id);
        }
    }
    return {
        scanned: prevRecords.length,
        dropped: ctx.dropped,
        records_cleaned: cleaned,
        sample,
    };
}
