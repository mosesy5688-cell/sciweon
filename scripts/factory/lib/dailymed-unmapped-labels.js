import { lookupByNdc } from '../../ingestion/adapters/rxnorm-bulk-adapter.js';
import { normalizeNdcTo11Digit } from './ndc-normalize.js';

/**
 * PR-MD-1g-probe: diagnose the no_rxcui label pool (labels that hydrate to ZERO
 * rxcui -- the single largest unlinked bucket, ~500 of 1394, link rate ~37%).
 *
 * For each drug-label with empty rxcui[], split no-ndc vs ndcs-all-unmapped (by
 * construction all unmapped, else the hydrator would have filled rxcui[]), then
 * re-run the SAME hydrator path (normalizeNdcTo11Digit -> lookupByNdc) to tally WHY:
 *   malformed                      -- NDC does not normalize to 11 digits
 *   absent_from_accepted_sab_map   -- normalizes but 0 hits in OUR map
 *
 * COLLAR (deliberate naming): "absent_from_accepted_sab_map" means absent from our
 * RXNORM+MTHSPL ACCEPTED slice, NOT absent from RxNorm. Harvest EXCLUDED 507,123 NDCs
 * (VANDF/GS/MMX/MMSL/NDDF commercial SABs) > 487,374 accepted; those NDCs were dropped
 * at harvest and are NOT in bulkMaps.ndcToRxcuis, so this in-memory probe is BLIND to
 * them. A 0-hit NDC is LIKELY in RxNorm on an excluded SAB -- the honest next step is a
 * harvest-side excluded-SAB check + cheap SAB-widen, NOT an external NDC-directory claim.
 *
 * unexpected_mapped (expected 0): an NDC on a no_rxcui label that DOES map -- a hydration
 * anomaly surfaced rather than silently skipped (per [[cross_cycle_silent_data_loss]]).
 *
 * Pure, read-only, never throws. Fail-soft: no bulkMaps -> reverse_map_available:false +
 * label-level counts only (cannot re-lookup the NDC reason).
 *
 * @param {Array} drugLabelRecords  cumulative drug-label records
 * @param {object} bulkMaps  RxNorm bulk maps (ndcToRxcuis); may be null
 */
export function summarizeUnmappedLabels(drugLabelRecords, bulkMaps) {
    const out = {
        reverse_map_available: !!bulkMaps?.ndcToRxcuis,
        no_rxcui_labels: 0,
        no_ndc_labels: 0,
        ndcs_all_unmapped: 0,
        ndc_hits_malformed: 0,
        ndc_hits_absent_from_accepted_sab: 0,
        ndc_hits_unexpected_mapped: 0,
        sample_unmapped: [],
    };
    for (const r of drugLabelRecords ?? []) {
        if (!r?.id?.startsWith?.('sciweon::drug_label::')) continue;
        const rx = Array.isArray(r.rxcui) ? r.rxcui : [];
        if (rx.length > 0) continue;  // only the no_rxcui pool
        out.no_rxcui_labels++;
        const ndcs = Array.isArray(r.ndcs) ? r.ndcs : [];
        if (ndcs.length === 0) { out.no_ndc_labels++; continue; }
        out.ndcs_all_unmapped++;
        if (!out.reverse_map_available) continue;  // fail-soft: no per-NDC reason
        for (const ndc of ndcs) {
            const normalized = typeof ndc === 'string' ? normalizeNdcTo11Digit(ndc) : null;
            let reason;
            if (!normalized) { out.ndc_hits_malformed++; reason = 'malformed'; }
            else if (lookupByNdc(bulkMaps, normalized).size === 0) { out.ndc_hits_absent_from_accepted_sab++; reason = 'absent_from_accepted_sab_map'; }
            else { out.ndc_hits_unexpected_mapped++; reason = 'unexpected_mapped'; }
            if (out.sample_unmapped.length < 15) out.sample_unmapped.push({ ndc, normalized: normalized ?? null, reason });
        }
    }
    return out;
}
