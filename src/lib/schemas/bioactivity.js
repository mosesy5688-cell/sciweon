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
    target_id: { type: 'string', required: true },

    // ─── Activity Measurement ───
    activity_type: {
        type: 'string', required: true,
        enum: ['IC50', 'Ki', 'EC50', 'AC50', 'Kd', 'IC90', 'GI50', 'inhibition', 'other'],
    },
    value: { type: 'number', required: true, min: 0 },
    unit: { type: 'string', required: true, enum: ['nM', 'uM', 'mM', 'M', 'percent', 'unitless'] },

    // ─── Quality Flags (Negative Evidence enabler) ───
    is_active: { type: 'boolean', required: false },
    // Real ChEMBL comments contain detailed methodology — widened from 200 to 4000
    activity_comment: { type: 'string', required: false, maxLength: 4000 },
    confidence_score: { type: 'integer', required: false, min: 0, max: 9 }, // ChEMBL native 0-9

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
