/**
 * Pure formatter for the F3 DailyMed telemetry lines. Returns a multi-line string,
 * one per log prefix, so operators grep [BACKFILL/dailymed-relink],
 * [BACKFILL/dailymed-label-harm], and [BACKFILL/dailymed-typed-split] separately.
 *
 * Extracted from dailymed-crosslink.js (PR-MD-1f-probe Collar 1): crosslink.js is the
 * SSoT join and keeps growing, so the formatter does not belong on its Art 5.1
 * 250-line cap edge. No I/O -- the caller console.logs the result.
 *
 * PR-MD-1f-probe typed-split semantics: in_present = corpus-bound (projection no net
 * gain, except an undetermined tradename co-ingredient residual). no_in_rxnrel_reachable
 * is TTY-ELIGIBLE only -- edge-existence is TBD by the fix-PR (Collar 2: these stranded
 * BECAUSE the harvest projector had no edge), NOT a confirmed cheap fix.
 * no_in_tradename_bn needs a has_tradename harvest; no_in_name_type has no RXNREL path.
 */
export function formatDailymedRelinkLog(rl) {
    const b = rl.buckets, lp = rl.labelProductivity, h = lp.harm_reason, t = lp.typed_breakdown, u = rl.unmappedLabels;
    return `[BACKFILL/dailymed-relink] labels_rehydrated=${rl.labelsRehydrated} dailymed_by_rxcui=${rl.dmByRxcuiSize} cumulative_dm_linked=${rl.dmLinked} | buckets: reverse_map=${b.reverse_map_available} total=${b.total_label_rxcui} productive=${b.productive} in_corpus_unstamped=${b.in_corpus_unstamped} stamp_drift=${b.in_corpus_stamp_drift} not_in_corpus=${b.not_in_corpus} no_unii_bridge=${b.no_unii_bridge} | samples not_in_corpus=${JSON.stringify(b.samples.not_in_corpus)} no_unii_bridge=${JSON.stringify(b.samples.no_unii_bridge)}\n`
        + `[BACKFILL/dailymed-label-harm] labels_linked=${lp.labels_linked} labels_zero_productive=${lp.labels_zero_productive} labels_no_rxcui=${lp.labels_no_rxcui} total_with_rxcui=${lp.total_labels_with_rxcui} | reason: projection_gap_typed=${h.projection_gap_typed} projection_gap_null_tty=${h.projection_gap_null_tty} not_in_corpus=${h.not_in_corpus} mixed=${h.mixed_or_other} corpus_fixable=${lp.corpus_fixable} (precedence-free) | samples=${JSON.stringify(lp.samples.zero_productive)}\n`
        + `[BACKFILL/dailymed-typed-split] in_present=${t.in_present} (corpus-bound) no_in_rxnrel_reachable=${t.no_in_rxnrel_reachable} (TTY-eligible; edge-existence TBD) no_in_tradename_bn=${t.no_in_tradename_bn} no_in_name_type=${t.no_in_name_type} (no RXNREL path) no_in_other=${t.no_in_other} | samples=${JSON.stringify(lp.samples.typed_no_in)}\n`
        + `[BACKFILL/dailymed-no-rxcui-diag] no_rxcui_labels=${u.no_rxcui_labels} no_ndc_labels=${u.no_ndc_labels} ndcs_all_unmapped=${u.ndcs_all_unmapped} | ndc_reasons: malformed=${u.ndc_hits_malformed} absent_from_accepted_sab_map=${u.ndc_hits_absent_from_accepted_sab} (NOT absent_from_rxnorm -- excluded-SAB blind) unexpected_mapped=${u.ndc_hits_unexpected_mapped} | samples=${JSON.stringify(u.sample_unmapped)}`;
}
