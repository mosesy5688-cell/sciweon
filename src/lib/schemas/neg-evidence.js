/**
 * NegEvidence entity schema — Sciweon V0.4
 *
 * Unified Negative Evidence aggregation. One entity type covers all
 * categories of "this compound failed X" / "this drug was retracted /
 * withdrawn" / "this assay was inactive".
 *
 * Sciweon-computed synthesis of primary signals already in the data
 * graph — NOT a new external data source. The synthesis is the value:
 * Agent queries one entity to learn every negative signal across all
 * source DBs.
 *
 * Source signals integrated (V0.4.2):
 *   - trial_failure         (from negative-evidence-raw.jsonl)
 *   - serious_adverse_event_per_trial (from trial.results.serious_events_count)
 *   - paper_retraction      (from paper.is_retracted)
 *   - inactive_bioassay     (from bioactivity.is_active=false)
 *   - black_box_warning     (from compound.fda_signals.boxed_warning_text)
 *   - drug_withdrawal       (from compound.drug_status.withdrawn)
 *   - faers_adr_signal      (from compound.fda_signals.faers_top_adr_terms)
 */

import { NEG_EVIDENCE_TYPES, NEG_EVIDENCE_CANON_VERSIONS } from './neg-evidence-types.js';

export const NEG_EVIDENCE_SCHEMA = {
    // ─── Identity ───
    id: { type: 'string', required: true, pattern: /^sciweon::neg::/ },

    // evidence_type canonical taxonomy lives in ./neg-evidence-types.js — the
    // SSoT consumed by the schema, the worker filter (event-type-taxonomy.ts),
    // and all factory builders. Adding a new type means appending to that
    // module; this enum picks it up automatically on next load.
    evidence_type: {
        type: 'string', required: true,
        enum: [...NEG_EVIDENCE_TYPES],
    },

    // ─── Subject (what failed) ───
    subject: {
        type: 'object', required: true,
        shape: {
            compound_id: { type: 'string', required: false, pattern: /^sciweon::compound::/ },
            target_id: { type: 'string', required: false },
            paper_id: { type: 'string', required: false, pattern: /^sciweon::paper::/ },
            trial_id: { type: 'string', required: false, pattern: /^sciweon::trial::/ },
            bioactivity_id: { type: 'string', required: false },
        },
    },

    // ─── Failure Details ───
    // reason_category enum varies by evidence_type:
    //   trial_failure: SAFETY/EFFICACY/ENROLLMENT/FUNDING/LOGISTICS/BUSINESS/REGULATORY/COVID/OTHER
    //                  (from V0.1 keyword classifier)
    //   paper_retraction: V0.4 has the canonical retraction notice DOI but
    //                     not the reason classification (deferred to V0.5 NLP)
    //   inactive_bioassay: 'concentration_inactive' / 'inhibition_inactive'
    //                      (from V0.2.2 bioactivity-scorer)
    //   black_box_warning: 'fda_required_boxed_warning' (raw text in detail.text)
    //   drug_withdrawal: from ChEMBL withdrawn_reason if present
    //   faers_adr_signal: MedDRA Preferred Term (ICH international vocabulary)
    failure: {
        type: 'object', required: true,
        shape: {
            reason_category: { type: 'string', required: false, maxLength: 100 },
            // PR-T1.1a uncap: 4000 -> 40000. The boxed-warning NegEvidence
            // carries the FULL FDA-mandated warning text (preserve-all); the
            // adversary panel's 3rd missed cap was neg-builders-fda's .slice(0,
            // 4000) -- removed there, this 40000 schema cap now bounds it.
            reason_text: { type: 'string', required: false, maxLength: 40000 },
            extraction_method: {
                type: 'string', required: true,
                enum: [
                    'v0.1_keyword_classifier',
                    'sciweon_value_threshold_v1',
                    'fda_label_section',
                    'retraction_watch_canonical',
                    'pubmed_pubtype_canonical',
                    'multi_source_consensus',
                    'openfda_aggregation',
                    'source_provided',
                ],
            },
            extraction_confidence: { type: 'integer', required: false, min: 0, max: 100 },
        },
    },

    // ─── Type-specific signal detail ───
    // For faers_adr_signal: {meddra_pt, report_count}
    // For trial_failure: {phase, conditions[], sponsor}
    // For paper_retraction: {journal, retraction_date, retraction_doi}
    // For serious_adverse_event_per_trial: {events_count, other_events_count}
    // Free-form for flexibility — schema validation lets type-specific fields
    // pass without enumerating; agents read by evidence_type.
    detail: {
        type: 'object', required: false,
    },

    // ─── Temporal ───
    occurred_date: { type: 'string', required: false, format: 'iso8601_date' },
    observed_date: { type: 'string', required: true, format: 'iso8601' },

    // ─── Severity ───
    // critical: death / withdrawal / data fabrication / Phase III safety
    // major:    Phase II/III failure / serious AE / boxed warning
    // minor:    Phase I failure / inactive bioassay / minor AE
    // unknown:  insufficient signal for classification
    severity: {
        type: 'string', required: true,
        enum: ['critical', 'major', 'minor', 'unknown'],
    },

    // ─── Confidence (Sciweon-computed) ───
    confidence: {
        type: 'object', required: true,
        shape: {
            overall: { type: 'integer', required: true, min: 0, max: 100 },
            extraction_quality: { type: 'integer', required: false, min: 0, max: 100 },
            source_reliability: { type: 'integer', required: false, min: 0, max: 100 },
            method: { type: 'string', enum: ['negative_evidence_v1'] },
        },
    },

    // ─── Provenance ───
    provenance: {
        type: 'object', required: true,
        shape: {
            primary_source: {
                type: 'string', required: true,
                enum: [
                    'clinicaltrials_gov',
                    'ctis_ema',
                    'retraction_watch',
                    'pubmed_pubtype',
                    'chembl_inactive',
                    'openfda_drug_label',
                    'openfda_enforcement',
                    'openfda_faers',
                    'chembl_withdrawn',
                ],
            },
            source_url: { type: 'string', required: false, maxLength: 1000 },
            source_id: { type: 'string', required: true },
            extraction_timestamp: { type: 'string', required: true, format: 'iso8601' },
            extraction_method: { type: 'string', required: false, maxLength: 100 },
        },
    },

    // ─── Cross-source confirmation ───
    cross_source_confirmations: {
        type: 'array', required: false, maxItems: 10,
        itemShape: {
            source: { type: 'string', required: true },
            source_id: { type: 'string', required: false },
            agreement: { type: 'string', enum: ['full', 'partial', 'conflict'] },
        },
    },

    // ─── Phase 1.7 SID anchor metadata (Plan A1 per-type multi-canon) ───
    // Populated post-validation by neg-evidence-builder.js via
    // buildNegAnchorPayload (./neg-evidence-types.js). Optional at schema layer
    // so legacy pre-1.7 records validate; stamper requires all three present
    // and HARD-FAILS on missing per [[cross_cycle_silent_data_loss]].
    namespace: { type: 'string', required: false, enum: ['negevidence'] },
    anchor_payload: { type: 'string', required: false, maxLength: 500 },
    canonicalization_version: {
        type: 'string', required: false,
        enum: Object.values(NEG_EVIDENCE_CANON_VERSIONS),
    },
};
