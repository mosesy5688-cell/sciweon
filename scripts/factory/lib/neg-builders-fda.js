/**
 * NegEvidence builders for FDA-sourced signals on compounds.
 *
 * Three record types:
 *   - black_box_warning   (from compound.fda_signals.boxed_warning_text)
 *   - drug_withdrawal     (from compound.drug_status.withdrawn)
 *   - faers_adr_signal    (from compound.fda_signals.faers_top_adr_terms)
 *
 * FAERS signals are emitted as one NegEvidence record per (compound, ADR term)
 * pair. With 50 compounds × 30 top terms = ~1500 FAERS NegEvidence records.
 * Severity by FAERS report count:
 *   > 10,000 -> critical
 *   > 1,000  -> major
 *   > 100    -> minor
 *   else     -> unknown
 */

import {
    TYPE_BLACK_BOX_WARNING,
    TYPE_DRUG_WITHDRAWAL,
    TYPE_FAERS_ADR_SIGNAL,
} from '../../../src/lib/schemas/neg-evidence-types.js';

export function* buildFdaSignals(compounds) {
    const now = new Date().toISOString();
    for (const c of compounds) {
        const fdaSig = c.fda_signals;
        const drugStatus = c.drug_status;

        // black_box_warning
        if (fdaSig?.has_boxed_warning && fdaSig.boxed_warning_text) {
            yield {
                id: `sciweon::neg::boxed::${c.id.replace('sciweon::compound::', '')}`,
                evidence_type: TYPE_BLACK_BOX_WARNING,
                subject: { compound_id: c.id },
                failure: {
                    reason_category: 'fda_mandated_boxed_warning',
                    reason_text: fdaSig.boxed_warning_text.slice(0, 4000),
                    extraction_method: 'fda_label_section',
                    extraction_confidence: 100,
                },
                detail: {
                    application_numbers: fdaSig.application_numbers,
                    pharm_class_epc: fdaSig.pharm_class_epc,
                    pharm_class_moa: fdaSig.pharm_class_moa,
                },
                occurred_date: null,
                observed_date: now,
                severity: 'critical',
                confidence: {
                    overall: 100,
                    extraction_quality: 100,
                    source_reliability: 100,
                    method: 'negative_evidence_v1',
                },
                provenance: {
                    primary_source: 'openfda_drug_label',
                    source_id: (fdaSig.application_numbers?.[0]) ?? c.external_ids?.unii ?? c.id,
                    extraction_timestamp: now,
                    extraction_method: 'openfda_drug_label_v1',
                },
            };
        }

        // drug_withdrawal
        if (drugStatus?.withdrawn === true) {
            yield {
                id: `sciweon::neg::withdrawn::${c.id.replace('sciweon::compound::', '')}`,
                evidence_type: TYPE_DRUG_WITHDRAWAL,
                subject: { compound_id: c.id },
                failure: {
                    reason_category: 'withdrawn_from_market',
                    reason_text: drugStatus.withdrawn_reason ?? null,
                    extraction_method: 'source_provided',
                    extraction_confidence: 90,
                },
                detail: {
                    chembl_id: c.chembl_id,
                    first_approval_year: drugStatus.first_approval_year,
                    max_phase: drugStatus.max_phase,
                    black_box_warning: drugStatus.black_box_warning,
                },
                occurred_date: null,
                observed_date: now,
                severity: 'critical',
                confidence: {
                    overall: 90,
                    extraction_quality: 90,
                    source_reliability: 90,
                    method: 'negative_evidence_v1',
                },
                provenance: {
                    primary_source: 'chembl_withdrawn',
                    source_id: c.chembl_id ?? c.id,
                    extraction_timestamp: now,
                    extraction_method: 'chembl_rest_v1',
                },
            };
        }

        // faers_adr_signal — one record per (compound, ADR term) pair
        const faersTerms = fdaSig?.faers_top_adr_terms ?? [];
        for (const t of faersTerms) {
            let severity = 'unknown';
            if (t.count >= 10000) severity = 'critical';
            else if (t.count >= 1000) severity = 'major';
            else if (t.count >= 100) severity = 'minor';
            const safeTerm = t.term.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
            yield {
                id: `sciweon::neg::faers::${c.id.replace('sciweon::compound::', '')}::${safeTerm}`,
                evidence_type: TYPE_FAERS_ADR_SIGNAL,
                subject: { compound_id: c.id },
                failure: {
                    reason_category: 'meddra_pt_adr',
                    reason_text: t.term,
                    extraction_method: 'openfda_aggregation',
                    extraction_confidence: 95,
                },
                detail: {
                    meddra_pt: t.term,
                    report_count: t.count,
                    unii: c.external_ids?.unii,
                },
                occurred_date: null,
                observed_date: now,
                severity,
                confidence: {
                    overall: 85,
                    extraction_quality: 95,
                    source_reliability: 90,
                    method: 'negative_evidence_v1',
                },
                provenance: {
                    primary_source: 'openfda_faers',
                    source_id: c.external_ids?.unii ?? c.id,
                    extraction_timestamp: now,
                    extraction_method: 'openfda_count_aggregation_v1',
                },
            };
        }
    }
}
