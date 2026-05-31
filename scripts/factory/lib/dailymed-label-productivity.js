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
// PR-MD-1f-probe TTY sets (strings confirmed from real data: harvest lost_tty
// GPCK/BPCK/SY/PSN/TMSY; F3 samples BN, IN). Ingredient-tier presence => corpus-bound.
// RXNREL_REACHABLE = TTY-ELIGIBLE for a has_ingredient/consists_of edge, NOT proof the
// edge exists (Collar 2: these stranded BECAUSE the harvest projector had no edge; the
// fix-PR must confirm edge-existence). NAME_TYPE atoms have no RXNREL relation at all.
const INGREDIENT_TIER = new Set(['IN', 'MIN', 'PIN']);
const RXNREL_REACHABLE = new Set(['SCD', 'SBD', 'GPCK', 'BPCK']);
const NAME_TYPE = new Set(['SY', 'PSN', 'TMSY']);

export function summarizeLabelProductivity(drugLabelRecords, compoundRxcui, rxcuiClass) {
    const out = {
        labels_no_rxcui: 0,
        total_labels_with_rxcui: 0,
        labels_linked: 0,
        labels_zero_productive: 0,
        harm_reason: { projection_gap_typed: 0, projection_gap_null_tty: 0, not_in_corpus: 0, mixed_or_other: 0 },
        // PR-MD-1g-probe: PRECEDENCE-FREE true corpus lever size = zero_productive labels with
        // >=1 not_in_corpus rxcui (has a UNII bridge -> adding the compound auto-stamps+links).
        // Supersets harm_reason.not_in_corpus (>=150) by also catching the corpus-fixable share
        // hidden inside typed/null_tty/mixed (incl. in_present labels whose IN is not_in_corpus).
        corpus_fixable: 0,
        // PR-MD-1f-probe: grades projection_gap_typed (sums to it). in_present = corpus-bound
        // (projection no net gain, EXCEPT an undetermined tradename co-ingredient residual --
        // NOT "0 value proven"). no_in_* = the (ii) TTY tri-split + catch-all.
        typed_breakdown: { in_present: 0, no_in_rxnrel_reachable: 0, no_in_tradename_bn: 0, no_in_name_type: 0, no_in_other: 0 },
        samples: { zero_productive: [], typed_no_in: [] },
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
        if (notInCorpus) out.corpus_fixable++;  // PR-MD-1g-probe: precedence-free
        if (out.samples.zero_productive.length < 10) {
            out.samples.zero_productive.push({
                setid: r.setid ?? null, reason,
                rxcui: rx.slice(0, 5).map(x => ({ rxcui: x, bucket: cls.get(x)?.bucket ?? null, tty: cls.get(x)?.tty ?? null })),
            });
        }
        // PR-MD-1f-probe: grade the typed lever. (i) in_present (corpus-bound) if any rxcui
        // is ingredient-tier; else (ii) tri-split by no_unii_bridge TTY, cheapest-actionable
        // precedence rxnrel_reachable > tradename_bn > name_type > other (catch-all).
        if (reason === 'projection_gap_typed') {
            const nbTtys = rx.filter(x => cls.get(x)?.bucket === 'no_unii_bridge').map(x => cls.get(x)?.tty ?? null);
            let sub;
            if (rx.some(x => INGREDIENT_TIER.has(cls.get(x)?.tty))) sub = 'in_present';
            else if (nbTtys.some(t => RXNREL_REACHABLE.has(t))) sub = 'no_in_rxnrel_reachable';
            else if (nbTtys.some(t => t === 'BN')) sub = 'no_in_tradename_bn';
            else if (nbTtys.some(t => NAME_TYPE.has(t))) sub = 'no_in_name_type';
            else sub = 'no_in_other';
            out.typed_breakdown[sub]++;
            if (sub !== 'in_present' && out.samples.typed_no_in.length < 10) {
                out.samples.typed_no_in.push({ setid: r.setid ?? null, sub, no_unii_bridge_ttys: nbTtys });
            }
        }
    }
    return out;
}
