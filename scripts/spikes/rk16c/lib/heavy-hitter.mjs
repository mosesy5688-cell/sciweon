/**
 * RK-16C OFFLINE SPIKE — SYNTHETIC heavy-hitter fixture (NOT corpus-grounded).
 *
 * The local 2026-05-13 corpus has NO degree-43,364 target (its max target
 * degree is 778). Production has a 43,364-degree target. To exercise the
 * mandatory two-level directory + the LIST read-budget proof at production
 * scale, this builds a SYNTHETIC fixture: ONE target_id with N (default 43,364)
 * deterministic synthetic activity rows. ALL results derived from this fixture
 * MUST be labeled SYNTHETIC / PARAMETER CANDIDATE (not corpus-grounded).
 */

export const HEAVY_HITTER_DEGREE = 43364;
export const HEAVY_HITTER_TARGET_ID = 'CHEMBL_SYNTH_HEAVY';

/**
 * Build N deterministic synthetic bioactivity rows all sharing one target_id.
 * Rows mimic the corpus shape (same fields project() reads) so the page/heap
 * measurements are representative; values cycle deterministically so a rebuild
 * is byte-identical.
 * @param {number} n
 * @returns {object[]}
 */
export function makeHeavyHitterRows(n = HEAVY_HITTER_DEGREE) {
    const types = ['IC50', 'Ki', 'EC50', 'AC50', 'Kd', 'inhibition', 'GI50', 'other'];
    const units = ['nM', 'uM', 'mM', 'M', 'percent', 'unitless'];
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
        const seq = String(i).padStart(7, '0');
        rows[i] = {
            id: `sciweon::bioactivity::SYNTH_${seq}`,
            compound_id: `sciweon::compound::CID:SYNTH_${String(i % 5000).padStart(5, '0')}`,
            target_id: HEAVY_HITTER_TARGET_ID,
            target: { chembl_id: 'CHEMBL9999999', uniprot_accession: 'P00000' },
            activity_type: types[i % types.length],
            value: (i % 1000) + 1,
            unit: units[i % units.length],
            is_active: i % 3 === 0 ? true : i % 3 === 1 ? false : null,
            provenance: {
                sources: [{
                    source: 'chembl', source_id: `SYNTH_${seq}`,
                    extraction_method: 'rk16c_spike_synthetic',
                }],
            },
        };
    }
    return rows;
}
