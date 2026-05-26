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
