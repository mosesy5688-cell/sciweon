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
