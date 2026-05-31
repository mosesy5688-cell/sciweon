/**
 * PR-MD-1e: F3-side label-level "zero productive rxcui" metric (resolve GUARD 1).
 *
 * The harvest-side ndc-projection-loss.js measures `lost` = NDCs stranded on a
 * non-ingredient rxcui -- an NDC-level UPPER BOUND on label harm. It cannot see
 * the label<->NDC grouping, so 32244 lost NDCs does NOT mean 32244 harmed labels:
 * a DailyMed label links if ANY of its NDCs reaches an ingredient rxcui carried by
 * a corpus compound. This function is the F3-side measurement -- the one place that
 * sees label.rxcui[] (hydrated from ndcs[]), the productive rxcui set, AND the
 * per-rxcui bucket -- so it reports the TRUE label-level harm.
 *
 * A label is:
 *   labels_no_rxcui        rxcui[] empty (unmapped-NDC axis; separate, counted for honesty)
 *   labels_linked          >=1 rxcui in compoundRxcui (drives dm_linked; NOT harmed even if
 *                          a sibling NDC stranded -- the duplicate-rescue isomorph)
 *   labels_zero_productive has rxcui but NONE productive == TRUE label-level harm
 *
 * Each zero-productive label gets ONE reason, by a fixed DETERMINISTIC precedence
 * (Note 1, order-independent of rxcui[] order) so the four reason buckets are
 * mutually exclusive and sum to labels_zero_productive:
 *   projection_gap_typed > projection_gap_null_tty > not_in_corpus > mixed_or_other
 *
 *   projection_gap_typed     a no_unii_bridge rxcui with a non-null TTY (product/pack
 *                            concept). RXNREL has_ingredient/consists_of closure CAN reach
 *                            it -> legitimate target of an RXNREL projection fix. NOTE 2:
 *                            this is itself a mild UPPER BOUND -- only pack (GPCK/BPCK via
 *                            consists_of) + SCD/SBD (via has_ingredient) are truly RXNREL-
 *                            reachable; SY/PSN/TMSY (name-type TTYs) are NOT. Samples carry
 *                            per-rxcui tty so 1f can inspect the typed TTY composition
 *                            (pack/SCD/SBD = real target vs SY/PSN = unreachable).
 *   projection_gap_null_tty  the no_unii_bridge rxcui are ALL tty=null -- not even a captured
 *                            RXNCONSO concept. RXNREL projection is INEFFECTIVE (no node to
 *                            attach an edge to). The harvest ~88% main body. Fix must come
 *                            from the upstream MTHSPL NDC->ingredient source, NOT an RXNREL
 *                            edge. Flagged so PR-MD-1f is not mis-scoped.
 *   not_in_corpus            rxcui has a UNII bridge but no corpus compound (lever = corpus
 *                            expansion, the Cont 91 "165" path).
 *   mixed_or_other           in_corpus_unstamped / stamp_drift, or no class info (fail-soft).
 *
 * Pure, read-only, never throws. Diagnostic-only: callers log it, nothing mutates.
 *
 * @param {Array} drugLabelRecords  cumulative drug-label records (rxcui[] hydrated)
 * @param {Set<string>} compoundRxcui  rxcui carried by some compound (== productive)
 * @param {Map<string,{bucket,tty}>} rxcuiClass  per-rxcui bucket + tty (empty on no-bulkMaps)
 */
export function summarizeLabelProductivity(drugLabelRecords, compoundRxcui, rxcuiClass) {
    const out = {
        labels_no_rxcui: 0,
        total_labels_with_rxcui: 0,
        labels_linked: 0,
        labels_zero_productive: 0,
        harm_reason: { projection_gap_typed: 0, projection_gap_null_tty: 0, not_in_corpus: 0, mixed_or_other: 0 },
        samples: { zero_productive: [] },
    };
    const productive = compoundRxcui instanceof Set ? compoundRxcui : new Set();
    const cls = rxcuiClass instanceof Map ? rxcuiClass : new Map();
    for (const r of drugLabelRecords ?? []) {
        if (!r?.id?.startsWith?.('sciweon::drug_label::')) continue;
        const rx = Array.isArray(r.rxcui) ? r.rxcui : [];
        if (rx.length === 0) { out.labels_no_rxcui++; continue; }
        out.total_labels_with_rxcui++;
        if (rx.some(x => productive.has(x))) { out.labels_linked++; continue; }
        out.labels_zero_productive++;
        // Deterministic precedence (Note 1): scan all rxcui, set flags, pick once.
        let typed = false, nullTty = false, notInCorpus = false;
        for (const x of rx) {
            const c = cls.get(x);
            if (!c) continue;
            if (c.bucket === 'no_unii_bridge') { if (c.tty == null) nullTty = true; else typed = true; }
            else if (c.bucket === 'not_in_corpus') notInCorpus = true;
        }
        const reason = typed ? 'projection_gap_typed'
            : nullTty ? 'projection_gap_null_tty'
            : notInCorpus ? 'not_in_corpus'
            : 'mixed_or_other';
        out.harm_reason[reason]++;
        if (out.samples.zero_productive.length < 10) {
            out.samples.zero_productive.push({
                setid: r.setid ?? null, reason,
                rxcui: rx.slice(0, 5).map(x => ({ rxcui: x, bucket: cls.get(x)?.bucket ?? null, tty: cls.get(x)?.tty ?? null })),
            });
        }
    }
    return out;
}
