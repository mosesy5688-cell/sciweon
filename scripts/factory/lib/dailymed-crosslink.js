/**
 * DailyMed cross-link SSoT (PR-RXN-1g).
 *
 * The single source of truth for the compound <-> DailyMed-label join,
 * shared by BOTH consumers so increment and cumulative tracks never drift:
 *   - F2 increment: scripts/factory/adapter-cross-linker.js (runCrossLinker)
 *   - F3 cumulative: scripts/factory/aggregated-backfill-enrich.js (relink)
 *
 * Three pure functions:
 *   - hydrateLabelRxcuisFromNdcs: NDC[] -> label.rxcui[] via the RxNorm bulk Map
 *   - buildDailymedByRxcui:       rxcui -> label-summary[] index
 *   - linkCompoundsToDailymed:    attach summaries to compound.drug_labels
 */

import { lookupByNdc } from '../../ingestion/adapters/rxnorm-bulk-adapter.js';
import { normalizeNdcTo11Digit } from './ndc-normalize.js';

/**
 * PR-RXN-1b: hydrate drug_label.rxcui[] from drug_label.ndcs[] via RxNorm
 * bulk Map lookup. DailyMed v2 API never emits rxcui on label metadata; this
 * resolves NDC -> ingredient RxCUI through the graph-flattened bulk index.
 *
 * Fail-soft per-NDC ([[scope_vs_quality_validation_segregation]]): a single
 * unmapped NDC in a multi-NDC label MUST NOT nuke the parent label backlinks;
 * bucket-counted in excluded_unmapped_ndc_count. Combination-product 1:N:
 * lookupByNdc returns Set<{rxcui,...}>; label.rxcui[] gets the dedup union.
 * Idempotent: r.rxcui[] already non-empty -> skip. Deterministic: sorted.
 * Pure: mutates only r.rxcui on matching records, returns telemetry by value.
 */
export function hydrateLabelRxcuisFromNdcs(adapterRecords, maps) {
    const telemetry = {
        labels_with_ndcs: 0,
        labels_hydrated: 0,
        labels_zero_match: 0,
        labels_skipped_already_populated: 0,
        malformed_ndc_count: 0,
        unmapped_ndc_count: 0,
        excluded_unmapped_ndc_count: 0,
        sample_unmapped_ndcs: [],
    };
    if (!Array.isArray(adapterRecords)) return telemetry;
    for (const r of adapterRecords) {
        if (!r?.id?.startsWith?.('sciweon::drug_label::')) continue;
        if (!Array.isArray(r.ndcs) || r.ndcs.length === 0) continue;
        if (Array.isArray(r.rxcui) && r.rxcui.length > 0) {
            telemetry.labels_skipped_already_populated++;
            continue;
        }
        telemetry.labels_with_ndcs++;
        const resolved = new Set();
        for (const ndc of r.ndcs) {
            if (typeof ndc !== 'string' || ndc.length === 0) {
                telemetry.malformed_ndc_count++;
                telemetry.excluded_unmapped_ndc_count++;
                if (telemetry.sample_unmapped_ndcs.length < 10) {
                    telemetry.sample_unmapped_ndcs.push(`[MALFORMED] ${String(ndc)}`);
                }
                continue;
            }
            const normalized = normalizeNdcTo11Digit(ndc);
            if (!normalized) {
                telemetry.malformed_ndc_count++;
                telemetry.excluded_unmapped_ndc_count++;
                if (telemetry.sample_unmapped_ndcs.length < 10) {
                    telemetry.sample_unmapped_ndcs.push(`[MALFORMED] ${ndc}`);
                }
                continue;
            }
            const hits = lookupByNdc(maps, normalized);
            if (hits.size === 0) {
                telemetry.unmapped_ndc_count++;
                telemetry.excluded_unmapped_ndc_count++;
                if (telemetry.sample_unmapped_ndcs.length < 10) {
                    telemetry.sample_unmapped_ndcs.push(`[UNMAPPED] ${ndc} (${normalized})`);
                }
                continue;
            }
            for (const meta of hits) resolved.add(meta.rxcui);
        }
        if (resolved.size === 0) {
            telemetry.labels_zero_match++;
            continue;
        }
        r.rxcui = [...resolved].sort();
        telemetry.labels_hydrated++;
    }
    return telemetry;
}

/**
 * Build the rxcui -> label-summary[] index. Summary is the 4-field subset
 * that downstream (NegEvidence boxed-warning, API) consumes: setid /
 * title(<=200) / has_boxed_warning / published_date. Returns
 * Map<rxcui, Array<summary>>.
 */
export function buildDailymedByRxcui(drugLabelRecords) {
    const dailymedByRxcui = new Map();
    if (!Array.isArray(drugLabelRecords)) return dailymedByRxcui;
    for (const r of drugLabelRecords) {
        if (!r?.id?.startsWith?.('sciweon::drug_label::')) continue;
        for (const rxcui of (r.rxcui ?? [])) {
            if (!dailymedByRxcui.has(rxcui)) dailymedByRxcui.set(rxcui, []);
            dailymedByRxcui.get(rxcui).push({
                setid:            r.setid ?? null,
                title:            (r.title ?? '').slice(0, 200) || null,
                has_boxed_warning: r.has_boxed_warning ?? false,
                published_date:   r.published_date ?? null,
            });
        }
    }
    return dailymedByRxcui;
}

/**
 * Pure join: attach DailyMed label summaries to compounds whose
 * external_ids.rxcui intersects the label index. Mutates drug_labels in place
 * ONLY on a positive match (labels.length > 0) -- a non-match leaves any prior
 * F2-merged drug_labels intact. NEVER blind-clears: clearing on a non-match
 * would silently drop historical cross-cycle links per
 * [[cross_cycle_silent_data_loss]]. Preserves scalar-or-array rxcui
 * normalization. Returns { dmLinked }.
 */
export function linkCompoundsToDailymed(compounds, dailymedByRxcui) {
    let dmLinked = 0;
    for (const c of compounds) {
        const rxcui    = c?.external_ids?.rxcui;
        const rxcuiArr = Array.isArray(rxcui) ? rxcui : (rxcui ? [String(rxcui)] : []);
        const labels   = rxcuiArr.flatMap(r => dailymedByRxcui.get(r) ?? []);
        if (labels.length > 0) {
            c.drug_labels = labels;
            dmLinked++;
        }
    }
    return { dmLinked };
}

/**
 * PR-RXN-1g: F3 cumulative re-link orchestration. Pure given inputs (caller
 * reads the cumulative drug-label records from drug-labels.jsonl). Re-hydrate
 * label.rxcui[] from ndcs[] via the bulk Map (the join needs rxcui on BOTH
 * sides), build the index, and apply the SSoT join over the resident
 * compounds. Returns telemetry counts.
 */
export function relinkCumulativeDailymed(compounds, drugLabelRecords, bulkMaps) {
    const labelsRehydrated = bulkMaps
        ? hydrateLabelRxcuisFromNdcs(drugLabelRecords, bulkMaps).labels_hydrated : 0;
    const dmByRxcui = buildDailymedByRxcui(drugLabelRecords);
    const { dmLinked } = linkCompoundsToDailymed(compounds, dmByRxcui);
    const buckets = classifyDailymedRxcuiBuckets(compounds, dmByRxcui, bulkMaps);
    return { dmLinked, labelsRehydrated, dmByRxcuiSize: dmByRxcui.size, buckets };
}

/**
 * PR-MD-1c: classify every label-rxcui in the keyset to answer "of the
 * unproductive label-rxcui (match no stamped compound), how many are corpus
 * compounds lacking rxcui [grow UNII->RxCUI mapping] vs substances not in the
 * corpus [expand corpus] vs no-UNII-bridge". Pure, read-only, never throws.
 * Bridge is label-rxcui -> (invert uniiToRxcui) -> unii -> corpus compound.unii
 * (compounds carry UNII not NDC). Fail-soft: no bulkMaps -> reverse bridge
 * impossible -> reverse_map_available:false + zeros. Buckets:
 *   productive            R is carried by some compound (drives dm_linked)
 *   no_unii_bridge        R not in inverted map (non-ingredient / UNII-less rxcui)
 *   in_corpus_unstamped   R's unii on a corpus compound with rxcui==null (expect ~0;
 *                         >0 => bulk pre-pass gap alarm)
 *   in_corpus_stamp_drift R's unii on a stamped compound (different rxcui = map/REST drift)
 *   not_in_corpus         R's unii on no corpus compound (lever = expand corpus)
 */
export function classifyDailymedRxcuiBuckets(compounds, dmByRxcui, bulkMaps) {
    const zero = {
        reverse_map_available: false, total_label_rxcui: dmByRxcui?.size ?? 0,
        productive: 0, in_corpus_unstamped: 0, in_corpus_stamp_drift: 0,
        not_in_corpus: 0, no_unii_bridge: 0,
        samples: { in_corpus_unstamped: [], not_in_corpus: [], no_unii_bridge: [] },
    };
    if (!bulkMaps?.uniiToRxcui || !dmByRxcui) return zero;
    const compoundRxcui = new Set();
    const uniiStamp = new Map();  // unii -> { anyUnstamped, anyStamped }
    for (const c of compounds ?? []) {
        const rx = c?.external_ids?.rxcui;
        for (const r of Array.isArray(rx) ? rx : (rx ? [String(rx)] : [])) compoundRxcui.add(r);
        const u = c?.external_ids?.unii;
        if (typeof u === 'string' && u) {
            const e = uniiStamp.get(u) ?? { anyUnstamped: false, anyStamped: false };
            if (rx == null || (Array.isArray(rx) && rx.length === 0)) e.anyUnstamped = true; else e.anyStamped = true;
            uniiStamp.set(u, e);
        }
    }
    const rxcuiToUniis = new Map();
    for (const [unii, meta] of bulkMaps.uniiToRxcui) {
        const r = meta?.rxcui; if (!r) continue;
        if (!rxcuiToUniis.has(r)) rxcuiToUniis.set(r, new Set());
        rxcuiToUniis.get(r).add(unii);
    }
    const out = { ...zero, reverse_map_available: true };
    const push = (b, o) => { if (out.samples[b].length < 10) out.samples[b].push(o); };
    for (const R of dmByRxcui.keys()) {
        if (compoundRxcui.has(R)) { out.productive++; continue; }
        const uniis = rxcuiToUniis.get(R);
        if (!uniis || uniis.size === 0) { out.no_unii_bridge++; push('no_unii_bridge', { rxcui: R }); continue; }
        let unstamped = false, stamped = false, present = false, sampleUnii = null;
        for (const u of uniis) {
            const e = uniiStamp.get(u);
            if (e) { present = true; sampleUnii = sampleUnii ?? u; if (e.anyUnstamped) unstamped = true; if (e.anyStamped) stamped = true; }
        }
        if (unstamped) { out.in_corpus_unstamped++; push('in_corpus_unstamped', { rxcui: R, unii: sampleUnii }); }
        else if (stamped) { out.in_corpus_stamp_drift++; }
        else if (present) { out.in_corpus_stamp_drift++; }
        else { out.not_in_corpus++; push('not_in_corpus', { rxcui: R, unii: [...uniis][0] }); }
    }
    return out;
}
