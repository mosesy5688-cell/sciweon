/**
 * Trial entity schema — Sciweon V0.1
 *
 * Clinical trial from ClinicalTrials.gov.
 * Each Compound can have many Trials (linked via intervention name + synonyms).
 *
 * CRITICAL for Negative Evidence DB (V0.4):
 *   status = TERMINATED / WITHDRAWN + status_reason → Failure DB raw material
 *
 * See: brain/SCIWEON_DATA_ARCHITECTURE.md §3.3
 */

export const TRIAL_SCHEMA = {
    // ─── Identity ───
    id: { type: 'string', required: true, pattern: /^sciweon::trial::/ },
    nct_id: { type: 'string', required: true, pattern: /^NCT\d{8}$/ },

    // ─── Status (CRITICAL for Negative Evidence) ───
    status: {
        type: 'string', required: true,
        enum: [
            'RECRUITING', 'ACTIVE_NOT_RECRUITING', 'NOT_YET_RECRUITING', 'ENROLLING_BY_INVITATION',
            'COMPLETED', 'TERMINATED', 'WITHDRAWN', 'SUSPENDED', 'UNKNOWN', 'OTHER',
        ],
    },
    status_reason: { type: 'string', required: false, maxLength: 4000 },
    is_negative_outcome: { type: 'boolean', required: true }, // status in {TERMINATED, WITHDRAWN}

    // ─── Trial Details ───
    phase: { type: 'number', required: false, min: 0, max: 4 }, // 0=Early Phase 1, 1-4 = Phase 1-4
    conditions: { type: 'array', required: false, itemType: 'string', maxItems: 100 },

    interventions: {
        type: 'array', required: false, maxItems: 50,
        itemShape: {
            name: { type: 'string', required: true, maxLength: 500 },
            compound_id: { type: 'string', required: false }, // FK to Compound if matched
            mapping_confidence: { type: 'number', required: false, min: 0, max: 100 },
            type: {
                type: 'string', required: false,
                enum: ['DRUG', 'BIOLOGICAL', 'DEVICE', 'PROCEDURE', 'BEHAVIORAL', 'DIETARY_SUPPLEMENT', 'GENETIC', 'RADIATION', 'COMBINATION_PRODUCT', 'DIAGNOSTIC_TEST', 'OTHER'],
            },
        },
    },

    // ─── Enrollment ───
    enrollment: {
        type: 'object', required: false,
        shape: {
            target: { type: 'integer', required: false, min: 0 },
            actual: { type: 'integer', required: false, min: 0 },
            type: { type: 'string', required: false, enum: ['ACTUAL', 'ESTIMATED'] },
        },
    },

    // ─── Dates ───
    dates: {
        type: 'object', required: false,
        shape: {
            start: { type: 'string', required: false, format: 'iso8601_date' },
            completion: { type: 'string', required: false, format: 'iso8601_date' },
            primary_completion: { type: 'string', required: false, format: 'iso8601_date' },
        },
    },

    // ─── Sponsor ───
    sponsor: { type: 'string', required: false, maxLength: 500 },

    // ─── PROVENANCE (V8 mandatory) ───
    provenance: {
        type: 'object', required: true,
        shape: {
            sources: {
                type: 'array', required: true, minItems: 1,
                itemShape: {
                    source: { type: 'string', enum: ['clinicaltrials'] },
                    source_id: { type: 'string', required: true },
                    timestamp: { type: 'string', format: 'iso8601' },
                    extraction_method: { type: 'string', required: true },
                },
            },
            last_updated: { type: 'string', format: 'iso8601' },
        },
    },
};
