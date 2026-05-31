/**
 * PR-MD-1d: NDC -> ingredient projection-loss summary.
 *
 * Instruments the silent :193 fallback in rxnorm-rrf-streams.js loadIngredient-
 * Attributes: when productToIngredients has no edge for an NDC row's rxcui, the
 * NDC stays on the non-ingredient (product / Brand-Name) rxcui, carries no UNII,
 * and links no compound. That fallback was previously uncounted.
 *
 * lost = NDCs that fell back AND were never rescued by a parallel ingredient-
 * projecting row (= ndcsFallback keys NOT in ndcsProjected). Duplicate-row-rescue
 * robust: an NDC that ALSO appears on an SCD row (which projects to an ingredient)
 * is subtracted out, because RXNSAT attaches the same NDC on multiple concept-
 * level rows. So `lost` is the true link-loss bound, NOT the raw fallback rate
 * (which only counts fallback frequency and overcounts harm).
 *
 * GUARD 1 (do not over-act): `lost` is still an NDC-level UPPER BOUND on LABEL
 * harm -- a label with many NDCs links if ANY NDC reaches an ingredient. Confirm
 * label-level harm F3-side ("labels with zero productive rxcui") before launching
 * any projection-fix work off this number.
 *
 * tty_dist / sab_dist over the lost NDCs say HOW to fix (BN-dominated -> tradename
 * projection gap; SCD/SBD -> missing has_ingredient edge; MTHSPL vs RXNORM SAB).
 *
 * PR-MD-1e (A): tty_dist / sab_dist are counted PER DISTINCT LOST NDC (deduped via
 * a per-NDC Set), NOT per fallback hit. RXNSAT attaches the same NDC on multiple
 * concept rows, so the prior per-hit counting summed ABOVE `lost` (e.g. 35683 hit
 * incidences vs 32244 distinct lost NDCs) -- the distribution percentages were over
 * the wrong denominator. Now each tty/sab is counted once per NDC, so the dist
 * denominator is the `lost` set. `lost_pure_null_tty` = lost NDCs whose tty-set is
 * EXACTLY {null} (no typed/RXNCONSO concept on ANY fallback row): these have no
 * concept node for an RXNREL has_ingredient/consists_of edge to attach to, so an
 * RXNREL projection fix CANNOT reach them. They are the unrescuable-by-RXNREL main
 * body (harvest measured ~88%); the F3-side companion is PR-MD-1e
 * dailymed-label-productivity.js projection_gap_null_tty.
 *
 * @param {Set<string>} ndcsProjected  normalized NDCs that reached an ingredient
 * @param {Map<string, {rxcui,sab}[]>} ndcsFallback  normalized NDC -> fallback hits
 * @param {Map<string, {tty?}>} meta  rxcui -> meta (for TTY tagging); may be empty
 * @returns {{distinct_projected,distinct_fallback_only,fallback_rate_upper_bound,lost_pure_null_tty,tty_dist,sab_dist,samples}}
 */
export function summarizeNdcProjectionLoss(ndcsProjected, ndcsFallback, meta = new Map()) {
    const tty_dist = {};
    const sab_dist = {};
    const samples = [];
    let lost = 0;
    let lost_pure_null_tty = 0;
    for (const [ndc, hits] of (ndcsFallback ?? new Map())) {
        if (ndcsProjected?.has(ndc)) continue;  // rescued by a parallel ingredient row
        lost++;
        // PR-MD-1e (A): dedup tty/sab to one count per distinct NDC.
        const ttySet = new Set();
        const sabSet = new Set();
        for (const h of hits) {
            ttySet.add(meta.get(h.rxcui)?.tty || 'null');
            sabSet.add(h.sab);
        }
        for (const tty of ttySet) tty_dist[tty] = (tty_dist[tty] || 0) + 1;
        for (const sab of sabSet) sab_dist[sab] = (sab_dist[sab] || 0) + 1;
        if (ttySet.size === 1 && ttySet.has('null')) lost_pure_null_tty++;
        if (samples.length < 10) {
            samples.push({ ndc, rxcui: hits[0]?.rxcui ?? null, tty: meta.get(hits[0]?.rxcui)?.tty ?? null });
        }
    }
    const projected = ndcsProjected?.size ?? 0;
    const denom = projected + lost;
    const fallback_rate_upper_bound = denom > 0 ? +(100 * lost / denom).toFixed(2) : 0;
    return { distinct_projected: projected, distinct_fallback_only: lost, fallback_rate_upper_bound, lost_pure_null_tty, tty_dist, sab_dist, samples };
}
