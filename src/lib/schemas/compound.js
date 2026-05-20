/**
 * Compound entity schema — Sciweon V0.1
 * Strict contract per V8 first principles (machine-readable + validated + provenance + confidence).
 */

export const COMPOUND_SCHEMA = {
    // ─── Identity ───
    id: { type: 'string', required: true, pattern: /^sciweon::compound::/ },
    pubchem_cid: { type: 'number', required: false, min: 1 },
    chembl_id: { type: 'string', required: false, pattern: /^CHEMBL\d+$/ },
    inchi_key: { type: 'string', required: true, pattern: /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/ },
    // ─── External canonical IDs (V0.3.2 UniChem + V0.3.3 RxNorm) ───
    // International authority IDs sourced via UniChem (EMBL-EBI structural
    // cross-reference) + NLM RxNav. UniChem maps InChIKey -> canonical IDs
    // across major chemical DBs in one call; RxNorm maps UNII -> RXCUI.
    external_ids: {
        type: 'object', required: false,
        shape: {
            unii: { type: 'string', required: false, pattern: /^[A-Z0-9]{10}$/ },
            drugbank_id: { type: 'string', required: false, pattern: /^DB\d{5}$/ },
            chebi_id: { type: 'string', required: false, pattern: /^CHEBI:\d+$/ },
            kegg_drug_id: { type: 'string', required: false },
            hmdb_id: { type: 'string', required: false, pattern: /^HMDB\d+$/ },
            rxcui: { type: 'string', required: false, pattern: /^\d+$/ },
            rxnorm_name: { type: 'string', required: false, maxLength: 500 },
            rxnorm_tty: { type: 'string', required: false, maxLength: 20 },
            sources: { type: 'array', required: false, itemType: 'string', maxItems: 5 },
        },
    },

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
    // Cycle-4 CID:24763 hit length 2712 (macromolecule). Widened 1000 → 10000.
    iupac_name: { type: 'string', required: false, maxLength: 10000 },
    synonyms: { type: 'array', required: false, maxItems: 100, itemType: 'string' },

    // ─── Computed Properties ───
    properties: {
        type: 'object', required: false,
        shape: {
            log_p: {
                type: 'object', required: false,
                shape: {
                    // PR #20 widened max 30 → 80. Cycle-4 CID:24763 hit -70.2
                    // (macromolecule); widened min -25 → -150.
                    value: { type: 'number', min: -150, max: 80 },
                    method: { type: 'string', enum: ['XLogP3', 'AlogP', 'computed'] },
                },
            },
            tpsa: {
                type: 'object', required: false,
                shape: {
                    // 500 → 1500 (1K CID data) → 10000 (cycle-4 CID:24763=3040).
                    value: { type: 'number', min: 0, max: 10000 },
                    unit: { type: 'string', enum: ['angstrom_squared'] },
                },
            },
            complexity: { type: 'number', required: false, min: 0 },
            // 50 → 100 (5K CID) → 1000 (cycle-4 CID:24763 had 116 donors / 191 acceptors,
            // macromolecule). Large biomolecules have hundreds of H-bond sites.
            h_bond_donors: { type: 'integer', required: false, min: 0, max: 1000 },
            h_bond_acceptors: { type: 'integer', required: false, min: 0, max: 1000 },
            rotatable_bonds: { type: 'integer', required: false, min: 0, max: 200 },
            // Lipinski Rule of Five — computed from above 4 fields
            // Drug-likeness quick check. AI Agent screening uses this heavily.
            lipinski_violations: { type: 'integer', required: false, min: 0, max: 4 },
            // C1-4: RDKit-derived descriptors precomputed in stage-1 post-step
            // by scripts/factory/descriptor-precompute.py. All required:false
            // so pre-C1-4 records and SMILES-unparseable records pass validation.
            qed: { type: 'number', required: false, min: 0, max: 1 },
            aromatic_rings: { type: 'integer', required: false, min: 0, max: 50 },
            structural_alerts: {
                type: 'array', required: false,
                itemShape: {
                    name: { type: 'string', required: true, maxLength: 100 },
                    catalog: { type: 'string', required: true, enum: ['PAINS_A', 'PAINS_B', 'PAINS_C', 'Brenk'] },
                },
            },
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

    // ─── Structural Fingerprint (V0.3.5 — Agent need #2) ───
    // PubChem CACTVS 881-bit substructure keys, base64-encoded.
    // NIH-computed primary fingerprint (parallel to XLogP/TPSA computed
    // properties). Enables Tanimoto similarity search without RDKit dep.
    //
    // For V0.3.5 5K compound scale, brute-force Tanimoto pairwise is fine.
    // V0.1b 111M scale will require ANN index (HNSW); fingerprint format
    // stays the same, index added as separate R2 artifact.
    fingerprint: {
        type: 'object', required: false,
        shape: {
            // PubChem CACTVS Substructure Keys — base64 encoded.
            // Decode: 4-byte big-endian bit count header + 110 bytes (881 bits).
            cactvs_881: { type: 'string', required: false, maxLength: 200 },
            source: {
                type: 'string', required: false,
                enum: ['pubchem_cactvs_v2', 'rdkit_morgan_2048'],
            },
        },
    },

    // ─── KEGG Drug Network (V0.3.5 #3) ───
    // Kyoto University KEGG Drug entry: target genes (NCBI Gene IDs) +
    // pathway IDs + disease indications + ATC codes. Enables Agent to
    // answer "what pathway does this drug act on / what diseases?"
    // PRIMARY-only: international IDs (NCBI Gene / WHO ATC / KEGG pathway).
    // NOT consumed: CLASS DG-hierarchy / EFFICACY prose (KEGG team derived).
    kegg_drug: {
        type: 'object', required: false,
        shape: {
            d_number: { type: 'string', required: false, pattern: /^D\d{5}$/ },
            // ATC codes from KEGG REMARK (cross-source with ChEMBL atc_codes)
            atc_codes: { type: 'array', required: false, itemType: 'string', maxItems: 10 },
            // Drug-target genes (NCBI Gene primary IDs, international)
            targets: {
                type: 'array', required: false, maxItems: 50,
                itemShape: {
                    gene_symbol: { type: 'string', required: true, maxLength: 50 },
                    ncbi_gene_id: { type: 'string', required: false, pattern: /^\d+$/ },
                    kegg_orthology: { type: 'string', required: false, pattern: /^K\d+$/ },
                },
            },
            // KEGG pathway map IDs (international pathway taxonomy)
            pathways: { type: 'array', required: false, itemType: 'string', maxItems: 50 },
            // Disease indications with KEGG disease IDs
            diseases: {
                type: 'array', required: false, maxItems: 50,
                itemShape: {
                    indication: { type: 'string', required: true, maxLength: 200 },
                    kegg_disease_id: { type: 'string', required: false, pattern: /^H\d{5}$/ },
                },
            },
        },
    },

    // ─── FDA Regulatory Signals (V0.3.4 openFDA) ───
    // FDA-curated drug regulatory data — black box warnings + recall history.
    // Direct input for V0.4 Negative Evidence DB categories D (drug
    // withdrawal + black box) and pharmacological context.
    fda_signals: {
        type: 'object', required: false,
        shape: {
            has_drug_label: { type: 'boolean', required: false },
            label_count: { type: 'integer', required: false, min: 0 },
            has_boxed_warning: { type: 'boolean', required: false },
            // FDA-mandated boxed warning text (primary fact, sponsor-supplied
            // via FDA-required label sections). NOT a derived classification.
            boxed_warning_text: { type: 'string', required: false, maxLength: 4000 },
            has_indications: { type: 'boolean', required: false },
            has_contraindications: { type: 'boolean', required: false },
            application_numbers: { type: 'array', required: false, itemType: 'string', maxItems: 20 },
            // FDA Established Pharmacologic Class — FDA authoritative international
            // standard, parallel to WHO ATC codes (authoritative-source exempt).
            pharm_class_epc: { type: 'array', required: false, itemType: 'string', maxItems: 20 },
            pharm_class_moa: { type: 'array', required: false, itemType: 'string', maxItems: 20 },
            recall_count: { type: 'integer', required: false, min: 0 },
            most_severe_recall_class: {
                type: 'string', required: false,
                enum: ['Class I', 'Class II', 'Class III', null],
            },
            // V0.4.1 FAERS signal-level aggregation
            // Agent demand: quantified safety signals ("compound X has N
            // hepatotoxicity reports"), not 24M individual records.
            // MedDRA PT (Preferred Terms) — ICH international medical
            // vocabulary, primary authoritative-source exempt.
            faers_top_adr_terms: {
                type: 'array', required: false, maxItems: 30,
                itemShape: {
                    term: { type: 'string', required: true, maxLength: 200 },
                    count: { type: 'integer', required: true, min: 0 },
                },
            },
            faers_total_top_count: { type: 'integer', required: false, min: 0 },
            sources: { type: 'array', required: false, itemType: 'string', maxItems: 5 },
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
            // V0.5.1 PR #12 introduced confidence-scorer V2; keep v1 in the enum so prior-cycle data still validates.
            method: { type: 'string', enum: ['cross_source_consensus_v1', 'cross_source_consensus_v2'] },
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
