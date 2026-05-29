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
    return { dmLinked, labelsRehydrated, dmByRxcuiSize: dmByRxcui.size };
}
