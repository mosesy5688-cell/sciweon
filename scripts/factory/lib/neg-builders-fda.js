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

// R5 LOUD one-but-not-other telemetry: a record carrying boxed_warning_text but
// NO boxed_warnings[] (un-migrated, served via fallback) OR boxed_warnings[]
// but no boxed_warning_text (the back-compat write somehow missing). Both are
// data-shape anomalies that must be COUNTED, not silently absorbed.
export const boxedWarningStats = { migratedArray: 0, legacyFallback: 0, arrayButNoText: 0 };

export function resetBoxedWarningStats() {
    boxedWarningStats.migratedArray = 0;
    boxedWarningStats.legacyFallback = 0;
    boxedWarningStats.arrayButNoText = 0;
}

// FNV-1a short hash of the warning text -> a stable per-element id SUFFIX so
// multiple warnings on one compound do NOT collide to a single neg id (the
// adversary panel flagged today's single ::<cid> id = a 1-of-N drop).
function shortTextHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function boxedNegRecord(c, text, idSuffix, now) {
    const fdaSig = c.fda_signals;
    return {
        id: `sciweon::neg::boxed::${c.id.replace('sciweon::compound::', '')}${idSuffix}`,
        evidence_type: TYPE_BLACK_BOX_WARNING,
        subject: { compound_id: c.id },
        failure: {
            reason_category: 'fda_mandated_boxed_warning',
            // R5: NO slice -- the 40000 schema cap bounds it (the adversary
            // panel's 3rd missed cap was the old .slice(0,4000) here).
            reason_text: text,
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
            overall: 100, extraction_quality: 100, source_reliability: 100,
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

export function* buildFdaSignals(compounds) {
    const now = new Date().toISOString();
    for (const c of compounds) {
        const fdaSig = c.fda_signals;
        const drugStatus = c.drug_status;

        // black_box_warning. R5: prefer boxed_warnings[] (one NegEvidence per
        // warning, per-element id suffix so N warnings don't collide to 1 id);
        // fall back to the single boxed_warning_text for un-migrated records.
        const warnings = fdaSig?.boxed_warnings;
        if (fdaSig?.has_boxed_warning && Array.isArray(warnings) && warnings.length > 0) {
            boxedWarningStats.migratedArray += 1;
            if (!fdaSig.boxed_warning_text) boxedWarningStats.arrayButNoText += 1;
            for (let i = 0; i < warnings.length; i++) {
                const text = warnings[i]?.text;
                if (typeof text !== 'string' || text.length === 0) continue;
                // Suffix = index + short text hash: distinct AND order-stable.
                yield boxedNegRecord(c, text, `::${i}::${shortTextHash(text)}`, now);
            }
        } else if (fdaSig?.has_boxed_warning && fdaSig.boxed_warning_text) {
            // Legacy fallback: un-migrated record (no boxed_warnings[] yet).
            boxedWarningStats.legacyFallback += 1;
            yield boxedNegRecord(c, fdaSig.boxed_warning_text, '', now);
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
