/**
 * Compound entity schema — Sciweon V0.1
 * Strict contract per V8 first principles (machine-readable + validated + provenance + confidence).
 *
 * See: brain/SCIWEON_DATA_ARCHITECTURE.md §3.1
 */

export const COMPOUND_SCHEMA = {
    // ─── Identity ───
    id: { type: 'string', required: true, pattern: /^sciweon::compound::/ },
    pubchem_cid: { type: 'number', required: false, min: 1 },
    chembl_id: { type: 'string', required: false, pattern: /^CHEMBL\d+$/ },
    inchi_key: { type: 'string', required: true, pattern: /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/ },

    // ─── Structure ───
    smiles_canonical: { type: 'string', required: true, maxLength: 4000 },
    inchi: { type: 'string', required: true, maxLength: 4000 },
    // Molecular formula: allows elements (C, Ca, Fe...) + counts + charge (+/-) suffixes
    // Examples: C9H18NO4+, [Fe+3], C6H12O6
    molecular_formula: { type: 'string', required: true, pattern: /^([A-Z][a-z]?\d*)+[+\-\d]*$/ },
    molecular_weight: {
        type: 'object', required: true,
        shape: {
            value: { type: 'number', min: 0, max: 10000 },
            unit: { type: 'string', enum: ['Da'] },
        },
    },

    // ─── Names ───
    iupac_name: { type: 'string', required: false, maxLength: 1000 },
    synonyms: { type: 'array', required: false, maxItems: 100, itemType: 'string' },

    // ─── Computed Properties ───
    properties: {
        type: 'object', required: false,
        shape: {
            log_p: {
                type: 'object', required: false,
                shape: {
                    // Range widened progressively from 5000 CID empirical data.
                    // Real extremes: -14 (hydrophilic), +26.8 (extreme lipophilic dyes).
                    value: { type: 'number', min: -25, max: 30 },
                    method: { type: 'string', enum: ['XLogP3', 'AlogP', 'computed'] },
                },
            },
            tpsa: {
                type: 'object', required: false,
                shape: {
                    // Range widened from 500 → 1500 based on 1000 CID empirical data.
                    // Real extremes: up to 685 for large polar molecules (peptides, polyphenols).
                    value: { type: 'number', min: 0, max: 1500 },
                    unit: { type: 'string', enum: ['angstrom_squared'] },
                },
            },
            complexity: { type: 'number', required: false, min: 0 },
            // Widened max 50 → 100 based on 5000 CID data (CID 3807/4672 had 53/54 acceptors).
            // Large peptides / oligosaccharides routinely exceed 50 H-bond sites.
            h_bond_donors: { type: 'integer', required: false, min: 0, max: 100 },
            h_bond_acceptors: { type: 'integer', required: false, min: 0, max: 100 },
            rotatable_bonds: { type: 'integer', required: false, min: 0, max: 200 },
            // Lipinski Rule of Five — computed from above 4 fields
            // Drug-likeness quick check. AI Agent screening uses this heavily.
            lipinski_violations: { type: 'integer', required: false, min: 0, max: 4 },
        },
    },

    // ─── Drug Development Status ───
    drug_status: {
        type: 'object', required: false,
        shape: {
            // ChEMBL max_phase semantics:
            //   -1 = Unknown / not in clinical development (21/363 in 1K test)
            //    0 / 0.5 = Preclinical
            //    1 / 1.5 / 2 / 2.5 / 3 / 3.5 = Phase 1-3 (sometimes intermediate)
            //    4 = Approved / Marketed
            max_phase: { type: 'number', required: false, min: -1, max: 4 },
            first_approval_year: { type: 'integer', required: false, min: 1800, max: 2100 },
            withdrawn: { type: 'boolean', required: true },
            withdrawn_reason: { type: 'string', required: false, maxLength: 2000 },
            black_box_warning: { type: 'boolean', required: true },
            atc_codes: { type: 'array', required: false, itemType: 'string' },
        },
    },

    // ─── PROVENANCE (V8 mandatory) ───
    provenance: {
        type: 'object', required: true,
        shape: {
            sources: {
                type: 'array', required: true, minItems: 1,
                itemShape: {
                    source: { type: 'string', enum: ['pubchem', 'chembl'] },
                    source_id: { type: 'string', required: true },
                    timestamp: { type: 'string', format: 'iso8601' },
                    extraction_method: { type: 'string', required: true },
                },
            },
            last_updated: { type: 'string', format: 'iso8601' },
        },
    },

    // ─── CONFIDENCE (V8 mandatory) ───
    confidence: {
        type: 'object', required: true,
        shape: {
            overall: { type: 'number', min: 0, max: 100 },
            structural: { type: 'number', min: 0, max: 100 },
            bioactivity: { type: 'number', min: 0, max: 100 },
            clinical: { type: 'number', min: 0, max: 100 },
            method: { type: 'string', enum: ['cross_source_consensus_v1'] },
            cross_source_agreement: {
                type: 'object', required: true,
                shape: {
                    structural_match: { type: 'boolean' },
                    conflicts: { type: 'array', itemType: 'string' },
                },
            },
        },
    },

    // ─── Aggregated Stats ───
    stats: {
        type: 'object', required: false,
        shape: {
            paper_count: { type: 'integer', min: 0 },
            trial_count_active: { type: 'integer', min: 0 },
            trial_count_terminated: { type: 'integer', min: 0 },
            bioactivity_count_active: { type: 'integer', min: 0 },
            bioactivity_count_inactive: { type: 'integer', min: 0 },
        },
    },
};
