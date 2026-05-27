/**
 * RxNorm RXNREL.RRF graph projection (PR-RXN-1).
 *
 * Concept-level fix per architect 2026-05-27 audit:
 * UNII attributes attach at ingredient-level concepts (IN/PIN); NDC
 * attributes attach at product-level concepts (SCD/SBD/BPCK/GPCK).
 * Without traversing has_ingredient + consists_of relations to project
 * product-level RxCUIs DOWN to ingredient-level RxCUIs, downstream
 * RxCUI equality comparisons between compounds (UNII-side) and
 * DailyMed labels (NDC-side) are structurally guaranteed zero-match.
 *
 * Relation semantics:
 *   has_ingredient: RXCUI2 (product / SCD/SBD) -> RXCUI1 (ingredient / IN/PIN)
 *   consists_of:    RXCUI2 (pack / BPCK/GPCK)  -> RXCUI1 (SCD/SBD)
 *
 * Pack chain: BPCK consists_of SCD has_ingredient IN. Two-hop closure
 * computed at build time so callers do a single Map.get for any
 * product-level RxCUI.
 *
 * Combination products legitimately produce 1:N edges; values are Set
 * to preserve multiplicity (no first-only silent drop).
 */

/**
 * Build product -> Set<ingredient> projection from RXNREL rows.
 *
 * @param {Iterable<Object>} rxnrelRows  rows from RXNREL.RRF parse, each with
 *   RXCUI1, RXCUI2, RELA, REL, SUPPRESS, SAB columns
 * @returns {Map<string, Set<string>>}  product RXCUI -> Set of ingredient RXCUIs
 */
export function buildProductToIngredientsMap(rxnrelRows) {
    const hasIngredient = new Map();   // product -> Set<ingredient>
    const consistsOf = new Map();      // pack -> Set<scd>

    for (const row of rxnrelRows) {
        if (!row) continue;
        if (row.SUPPRESS && row.SUPPRESS !== 'N') continue;
        const rxcui1 = row.RXCUI1;
        const rxcui2 = row.RXCUI2;
        if (!rxcui1 || !rxcui2) continue;

        if (row.RELA === 'has_ingredient') {
            if (!hasIngredient.has(rxcui2)) hasIngredient.set(rxcui2, new Set());
            hasIngredient.get(rxcui2).add(rxcui1);
        } else if (row.RELA === 'consists_of') {
            if (!consistsOf.has(rxcui2)) consistsOf.set(rxcui2, new Set());
            consistsOf.get(rxcui2).add(rxcui1);
        }
    }

    // Two-hop closure: for each pack, traverse consists_of -> SCD, then
    // SCD has_ingredient -> IN. Merge resulting ingredient Set back into
    // the pack's mapping so callers see a single flat edge.
    for (const [pack, scds] of consistsOf) {
        if (!hasIngredient.has(pack)) hasIngredient.set(pack, new Set());
        const flat = hasIngredient.get(pack);
        for (const scd of scds) {
            const ings = hasIngredient.get(scd);
            if (!ings) continue;
            for (const ing of ings) flat.add(ing);
        }
    }

    return hasIngredient;
}
