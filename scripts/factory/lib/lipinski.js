/**
 * Lipinski Rule of Five — drug-likeness quick check.
 *
 * Rules (a compound violates if):
 *   - Molecular weight > 500 Da
 *   - LogP > 5
 *   - H-bond donors > 5
 *   - H-bond acceptors > 10
 *
 * Returns: number of violations (0-4, fewer = more drug-like)
 */

export function computeLipinskiViolations(properties, molecular_weight) {
    let violations = 0;
    const mw = molecular_weight?.value ?? molecular_weight;
    if (mw != null && mw > 500) violations++;
    if (properties?.log_p?.value != null && properties.log_p.value > 5) violations++;
    if (properties?.h_bond_donors != null && properties.h_bond_donors > 5) violations++;
    if (properties?.h_bond_acceptors != null && properties.h_bond_acceptors > 10) violations++;
    return violations;
}
