/**
 * Deep-merge strategy for compounds-enriched.jsonl in F3 cumulative-merge
 * (PR-CORE-MERGE-LEAK, cycle 23).
 *
 * Default merge (whole-record replace, "current wins") is destructive when
 * current is a fresh F2 baseline-derived record that lost some F3-stage
 * enrichment held in prev (e.g. UniChem returned UNII last cycle but null
 * this cycle; OT known_drug_info; SID stamps). deepMergeCompound preserves
 * prev's non-null fields in those scenarios so the cumulative aggregate
 * monotonic-grows instead of flat-lining at a destructive equilibrium.
 *
 * Field policy:
 *   - Top-level scalars: current wins (latest cycle's freshest data)
 *   - external_ids: non-null-preference deep-merge; current null does NOT
 *     overwrite prev non-null. UNII regression specifically defended.
 *   - external_ids.sources: array union (preserve cross-cycle stamp set)
 *   - structural fields (smiles/inchi/inchi_key): preserve prev when
 *     current null (defends against future upstream partial-ingest bugs)
 *   - F3-stage-only fields (known_drug_info, target_associations, sid_s,
 *     sid_c, *_license): preserve prev when current null/missing (F2
 *     output cannot carry these since they are added downstream in F3)
 */

export const F3_PRESERVE_FIELDS = Object.freeze([
    'known_drug_info', 'known_drug_info_license',
    'target_associations', 'target_associations_license',
    'sid_s', 'sid_c',
]);

export const STRUCTURAL_PRESERVE_FIELDS = Object.freeze([
    'smiles', 'smiles_canonical', 'inchi', 'inchi_key',
]);

export function makeDeepMergeCounters() {
    return {
        total: 0,
        preservedExternalIdFields: 0,
        unionedSources: 0,
        preservedStructuralFields: 0,
        preservedF3Fields: 0,
        sample: [],
    };
}

/**
 * PR-FDA-SRS-3c mass-bootstrap historical prev records to align with
 * Option E schema (external_ids.unichem_matched = true). Operates at the
 * true prev-load boundary with O(N) in-place scalar mutation.
 *
 * Decoupled from deepMergeCompound, which has intersection semantics
 * (per-record cur AND prev) and a prev-only early-return guard that
 * silent-skipped 28,097 prev-only records in PR-FDA-SRS-3 (F3 run
 * 26490754894). This function MUST flag every eligible prev record
 * regardless of whether a cur-cycle counterpart exists.
 *
 * Idempotent: records already flagged are skipped.
 */
export function bootstrapPrevRecords(prevRecords) {
    if (!Array.isArray(prevRecords)) return { count: 0, sample: [] };
    let count = 0;
    const sample = [];
    for (const rec of prevRecords) {
        const ext = rec?.external_ids;
        if (!ext) continue;
        if (ext.unichem_matched === true) continue;
        if (!Array.isArray(ext.sources) || !ext.sources.includes('unichem')) continue;
        if (ext.unii == null) continue;
        ext.unichem_matched = true;
        count++;
        if (sample.length < 10) sample.push(rec.id);
    }
    return { count, sample };
}

export function deepMergeCompound(prev, current, counters) {
    if (!prev) return current;
    if (!current) return prev;
    const merged = { ...prev, ...current };
    counters && counters.total++;

    if (prev.external_ids || current.external_ids) {
        const externalIdsMerged = { ...(prev.external_ids ?? {}), ...(current.external_ids ?? {}) };
        let preservedFields = 0;
        for (const k of Object.keys(externalIdsMerged)) {
            if (k === 'sources') continue;
            const c = current.external_ids?.[k];
            const p = prev.external_ids?.[k];
            const cIsEmpty = c == null
                || (Array.isArray(c) && c.length === 0)
                || (typeof c === 'string' && c === '');
            if (cIsEmpty && p != null) {
                externalIdsMerged[k] = p;
                preservedFields++;
            }
        }
        const prevSrc = Array.isArray(prev.external_ids?.sources) ? prev.external_ids.sources : [];
        const curSrc = Array.isArray(current.external_ids?.sources) ? current.external_ids.sources : [];
        const unioned = Array.from(new Set([...prevSrc, ...curSrc]));
        externalIdsMerged.sources = unioned;
        merged.external_ids = externalIdsMerged;
        if (counters) {
            counters.preservedExternalIdFields += preservedFields;
            if (unioned.length > Math.max(prevSrc.length, curSrc.length)) counters.unionedSources++;
            if (preservedFields > 0 && counters.sample.length < 10) counters.sample.push(merged.id);
        }
    }

    for (const f of STRUCTURAL_PRESERVE_FIELDS) {
        const c = current[f];
        if ((c == null || c === '') && prev[f] != null) {
            merged[f] = prev[f];
            counters && counters.preservedStructuralFields++;
        }
    }

    for (const f of F3_PRESERVE_FIELDS) {
        if (merged[f] == null && prev[f] != null) {
            merged[f] = prev[f];
            counters && counters.preservedF3Fields++;
        }
    }

    return merged;
}

/**
 * PR-CORE-DRUG-LABEL-LEAK 2026-05-28 (architect lock): deep-merge for
 * drug-labels.jsonl to prevent the same destructive replace-by-id class of
 * bug that PR-CORE-MERGE-LEAK fixed for compounds-enriched.jsonl.
 *
 * Without this strategy, F3 stage-3-merger would use default replace-by-id
 * semantics. Result: F2's local drug-labels.jsonl (which lacks ndcs[] + rxcui[]
 * when fan-in cumulative is not yet hydrated by the new PR-RXN-1b-pre
 * normalize() shape) would silently REVERSE the PR-RXN-1b-pre-promote
 * SHA256-verified hydration on next F3 cycle. Caught live by the cancelled
 * F3 run 26549696523 mid-flight.
 *
 * Field policy:
 *   - Top-level scalars (title, label_type, published_date etc.): current
 *     wins, per default merger (latest cycle's freshest text).
 *   - ndcs[]: preserve prev when current is empty/missing. The NLM /spls/
 *     {setid}/ndcs.json hop only runs on F1 re-harvest; absence in current
 *     does NOT mean absence in source.
 *   - rxcui[]: preserve prev when current is empty/missing. Result of
 *     cross-linker's PR-RXN-1b hydration; durable across cycles until a
 *     re-harvest legitimately advances the field.
 *
 * Symmetric to STRUCTURAL_PRESERVE_FIELDS guard in deepMergeCompound but
 * scoped to the drug_label entity axis.
 */
export function deepMergeDrugLabel(prev, current) {
    if (!prev) return current;
    if (!current) return prev;
    const merged = { ...prev, ...current };
    if ((current.ndcs == null || (Array.isArray(current.ndcs) && current.ndcs.length === 0)) && prev.ndcs != null) {
        merged.ndcs = prev.ndcs;
    }
    if ((current.rxcui == null || (Array.isArray(current.rxcui) && current.rxcui.length === 0)) && prev.rxcui != null) {
        merged.rxcui = prev.rxcui;
    }
    return merged;
}
