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
    // nct_id slot accepts CT.gov NCT IDs OR EU CTIS ctNumber (different ID
    // namespaces, both authoritative). V0.4 may split into separate fields.
    nct_id: { type: 'string', required: true, pattern: /^(NCT\d{8}|\d{4}-\d{6}-\d{2}-\d{2})$/ },
    // EU CTIS canonical trial number (when sourced from CTIS).
    ct_number: { type: 'string', required: false, pattern: /^\d{4}-\d{6}-\d{2}-\d{2}$/ },

    // ─── Status (CRITICAL for Negative Evidence) ───
    // Full CT.gov v2 API overallStatus value set (per official spec):
    // https://clinicaltrials.gov/data-api/about-api/study-data-structure#overallStatusEnum
    status: {
        type: 'string', required: true,
        enum: [
            'RECRUITING', 'ACTIVE_NOT_RECRUITING', 'NOT_YET_RECRUITING', 'ENROLLING_BY_INVITATION',
            'COMPLETED', 'TERMINATED', 'WITHDRAWN', 'SUSPENDED', 'UNKNOWN',
            'APPROVED_FOR_MARKETING', 'AVAILABLE', 'NO_LONGER_AVAILABLE',
            'TEMPORARILY_NOT_AVAILABLE', 'WITHHELD', 'OTHER',
            // EU CTIS overallStatus values (independent vocabulary from CT.gov)
            'AUTHORISED', 'ONGOING', 'ENDED', 'ENDED_PREMATURELY', 'HALTED',
            'CANCELLED', 'UNDER_EVALUATION', 'NOT_YET_AUTHORISED',
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

    // ─── Trial Results Section (V0.3.5 — Agent need #1) ───
    // Signal-level summary of ResultsSection; not raw measurement data.
    // Agent uses has_results + primary_outcomes + enrollment to decide:
    //   "did this drug work in trial?" / "was it adequately powered?"
    // Raw outcome_measures.classes.measurements stay in CT.gov — Sciweon does
    // not duplicate; Agent can fetch CT.gov directly when full detail needed.
    results: {
        type: 'object', required: false,
        shape: {
            has_results: { type: 'boolean', required: false },
            primary_outcomes: {
                type: 'array', required: false, maxItems: 20,
                itemShape: {
                    title: { type: 'string', required: false, maxLength: 500 },
                    type: { type: 'string', required: false, maxLength: 50 },
                    time_frame: { type: 'string', required: false, maxLength: 200 },
                    param_type: { type: 'string', required: false, maxLength: 50 },
                    group_count: { type: 'integer', required: false, min: 0 },
                    has_analyses: { type: 'boolean', required: false },
                },
            },
            secondary_outcomes_count: { type: 'integer', required: false, min: 0 },
            enrollment_actual: { type: 'integer', required: false, min: 0 },
            // Counts only; V0.4 NegEvidence Cat E will store individual AE records.
            serious_events_count: { type: 'integer', required: false, min: 0 },
            other_events_count: { type: 'integer', required: false, min: 0 },
            results_extracted_at: { type: 'string', required: false, format: 'iso8601' },
        },
    },

    // ─── Paper Cross-Link (CT.gov referencesModule) ───
    // Bidirectional link: trial → papers it cites; combined with paper.mentioned_trial_ids
    // for full provenance chain. Type per CT.gov: BACKGROUND / RESULT / DERIVED.
    references: {
        type: 'array', required: false, maxItems: 200,
        itemShape: {
            pmid: { type: 'string', required: true, pattern: /^\d+$/ },
            type: { type: 'string', required: false, enum: ['BACKGROUND', 'RESULT', 'DERIVED'] },
            citation: { type: 'string', required: false, maxLength: 2000 },
        },
    },

    // ─── PROVENANCE (V8 mandatory) ───
    provenance: {
        type: 'object', required: true,
        shape: {
            sources: {
                type: 'array', required: true, minItems: 1,
                itemShape: {
                    source: { type: 'string', enum: ['clinicaltrials', 'ctis'] },
                    source_id: { type: 'string', required: true },
                    timestamp: { type: 'string', format: 'iso8601' },
                    extraction_method: { type: 'string', required: true },
                },
            },
            last_updated: { type: 'string', format: 'iso8601' },
        },
    },
};
