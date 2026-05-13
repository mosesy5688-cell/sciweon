/**
 * Bioactivity entity schema — Sciweon V0.1
 *
 * Records a single compound-target activity measurement from ChEMBL.
 * Each Compound can have many Bioactivities (one-to-many).
 *
 * Critical for AI Agent: distinguishes active vs inactive results.
 * Inactive (is_active=false) feeds Negative Evidence DB (V0.4).
 *
 * See: brain/SCIWEON_DATA_ARCHITECTURE.md §3.2
 */

export const BIOACTIVITY_SCHEMA = {
    // ─── Identity ───
    id: { type: 'string', required: true, pattern: /^sciweon::bioactivity::/ },
    compound_id: { type: 'string', required: true, pattern: /^sciweon::compound::/ },
    target_id: { type: 'string', required: true }, // ChEMBL target_chembl_id; backward compat
    // ─── Target metadata (cross-source ChEMBL + UniProt, V0.2.2) ───
    // UniProt is the international protein authority (EMBL-EBI), independent
    // curation from ChEMBL. Together they provide multi-source target consensus.
    // Per feedback_no_secondary_processed_data: keywords / subcellularLocation /
    // features / dbReferences from UniProt are NOT consumed (curator-derived).
    target: {
        type: 'object', required: false,
        shape: {
            chembl_id: { type: 'string', required: false, pattern: /^CHEMBL\d+$/ },
            chembl_pref_name: { type: 'string', required: false, maxLength: 500 },
            target_type: { type: 'string', required: false, maxLength: 100 },
            // UniProt accession formats:
            //   6-char: [OPQ][0-9][A-Z0-9]{3}[0-9]   e.g. P00533
            //   10-char: [A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){2}  e.g. A0A0K6JZF8
            uniprot_accession: {
                type: 'string', required: false,
                pattern: /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/,
            },
            uniprot_id: { type: 'string', required: false, maxLength: 100 },
            protein_name: { type: 'string', required: false, maxLength: 500 },
            organism: {
                type: 'object', required: false,
                shape: {
                    taxon_id: { type: 'integer', required: false, min: 1 },
                    scientific_name: { type: 'string', required: false, maxLength: 200 },
                },
            },
            gene_symbol: { type: 'string', required: false, maxLength: 100 },
            sequence_length: { type: 'integer', required: false, min: 1, max: 100000 },
            sequence_mol_weight: { type: 'number', required: false, min: 0 },
            // List of sources that contributed to this target object.
            // 2 sources (chembl + uniprot) means cross-source verified.
            sources: { type: 'array', required: false, itemType: 'string', maxItems: 5 },
        },
    },

    // ─── Activity Measurement ───
    activity_type: {
        type: 'string', required: true,
        enum: ['IC50', 'Ki', 'EC50', 'AC50', 'Kd', 'IC90', 'GI50', 'inhibition', 'other'],
    },
    value: { type: 'number', required: true, min: 0 },
    unit: { type: 'string', required: true, enum: ['nM', 'uM', 'mM', 'M', 'percent', 'unitless', 'other'] },
    // Preserve original ChEMBL unit string (e.g. 'mg/kg', 'mol/L') when our enum doesn't cover it.
    // Agent can fall back to unit_raw for non-standard units.
    unit_raw: { type: 'string', required: false, maxLength: 100 },

    // ─── Quality Flags (Sciweon-computed, NOT consumed from ChEMBL secondary fields) ───
    // is_active is derived from value + unit + activity_type thresholds, not
    // from ChEMBL's `activity_comment` text (curator annotation). See
    // bioactivity-scorer.js and feedback_no_secondary_processed_data.
    is_active: { type: 'boolean', required: false },
    is_active_method: {
        type: 'string', required: false,
        enum: [
            'concentration_threshold_v1',     // IC50/Ki/EC50/Kd/AC50/IC90/GI50 in nM/uM/mM/M
            'concentration_inconclusive_v1',  // value in 1-10 uM gray zone
            'inhibition_threshold_v1',        // inhibition % > 50 or < 20
            'inhibition_inconclusive_v1',     // inhibition 20-50% gray zone
            'no_numeric_value',
            'non_standard_metric',
        ],
    },
    // Sciweon-computed confidence (0-100). ChEMBL's native confidence_score
    // (0-9) is a curator secondary assessment of target-assay reliability and
    // is intentionally NOT consumed.
    sciweon_confidence: { type: 'integer', required: false, min: 0, max: 100 },
    // Raw ChEMBL curator commentary preserved as TEXT only for V0.4 NLP entry.
    // No decision logic reads this field.
    activity_comment: { type: 'string', required: false, maxLength: 4000 },

    // ─── Assay Context ───
    assay_description: { type: 'string', required: false, maxLength: 4000 },
    assay_type: {
        type: 'string', required: false,
        enum: ['binding', 'functional', 'admet', 'toxicity', 'other'],
    },
    organism: { type: 'string', required: false, maxLength: 200 },

    // ─── PROVENANCE (V8 mandatory) ───
    provenance: {
        type: 'object', required: true,
        shape: {
            sources: {
                type: 'array', required: true, minItems: 1,
                itemShape: {
                    source: { type: 'string', enum: ['chembl'] },
                    source_id: { type: 'string', required: true },
                    timestamp: { type: 'string', format: 'iso8601' },
                    extraction_method: { type: 'string', required: true },
                },
            },
            last_updated: { type: 'string', format: 'iso8601' },
        },
    },
};
