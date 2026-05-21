/**
 * Tests for C1-1 Phase 2 — NegEvidence evidence_type SSoT.
 *
 * Guards three properties:
 *   1. SSoT is the same list referenced by schema enum + worker taxonomy.
 *   2. Producer-side gate REJECTs (throws) on an unknown evidence_type
 *      (silent-typo failure mode is structurally impossible).
 *   3. All seven canonical types still pass schema validation.
 *
 * If a future builder yields a new type without appending to the SSoT
 * tuple in src/lib/schemas/neg-evidence-types.js, the throw in (2) trips
 * and the GHA chain halts — no silent data loss.
 */

import { describe, it, expect } from 'vitest';
import { NEG_EVIDENCE_TYPES, isKnownEvidenceType } from '../../src/lib/schemas/neg-evidence-types.js';
import { NEG_EVIDENCE_SCHEMA } from '../../src/lib/schemas/neg-evidence.js';
import { EVIDENCE_TYPES } from '../../src/worker/lib/event-type-taxonomy';
import { gate, setMode, MODE_REJECT } from '../../scripts/factory/lib/validation-gate.js';

function baseRecord(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sciweon::neg::test::1',
        evidence_type: 'trial_failure',
        subject: { compound_id: 'sciweon::compound::CID:1' },
        failure: {
            reason_category: 'SAFETY',
            extraction_method: 'v0.1_keyword_classifier',
            extraction_confidence: 80,
        },
        observed_date: new Date().toISOString(),
        severity: 'critical',
        confidence: {
            overall: 80,
            extraction_quality: 80,
            source_reliability: 70,
            method: 'negative_evidence_v1',
        },
        provenance: {
            primary_source: 'clinicaltrials_gov',
            source_id: 'NCT00000001',
            extraction_timestamp: new Date().toISOString(),
        },
        ...overrides,
    };
}

describe('NEG_EVIDENCE_TYPES SSoT', () => {
    it('schema enum matches the SSoT exactly (same set, same length)', () => {
        const enumList = NEG_EVIDENCE_SCHEMA.evidence_type.enum as string[];
        expect(new Set(enumList)).toEqual(new Set(NEG_EVIDENCE_TYPES));
        expect(enumList).toHaveLength(NEG_EVIDENCE_TYPES.length);
    });

    it('worker EVIDENCE_TYPES is identity-equal to the SSoT (re-export, no shadow copy)', () => {
        expect(EVIDENCE_TYPES).toBe(NEG_EVIDENCE_TYPES);
    });

    it('isKnownEvidenceType accepts all 7 canonical strings and rejects a typo', () => {
        for (const t of NEG_EVIDENCE_TYPES) {
            expect(isKnownEvidenceType(t)).toBe(true);
        }
        expect(isKnownEvidenceType('trail_failure')).toBe(false); // typo
        expect(isKnownEvidenceType('')).toBe(false);
        expect(isKnownEvidenceType(undefined)).toBe(false);
    });
});

describe('producer-side enum enforcement (gate REJECT mode)', () => {
    it('valid record with each of the 7 types passes the schema gate', () => {
        setMode(MODE_REJECT);
        // Different per-type provenance/extraction_method requirements live in
        // their respective builders; here we vary the two fields that need
        // type-coherent enum values so the synthetic record passes.
        const variants: Array<{ evidence_type: string; primary_source: string; extraction_method: string }> = [
            { evidence_type: 'trial_failure', primary_source: 'clinicaltrials_gov', extraction_method: 'v0.1_keyword_classifier' },
            { evidence_type: 'inactive_bioassay', primary_source: 'chembl_inactive', extraction_method: 'sciweon_value_threshold_v1' },
            { evidence_type: 'drug_withdrawal', primary_source: 'chembl_withdrawn', extraction_method: 'source_provided' },
            { evidence_type: 'black_box_warning', primary_source: 'openfda_drug_label', extraction_method: 'fda_label_section' },
            { evidence_type: 'faers_adr_signal', primary_source: 'openfda_faers', extraction_method: 'openfda_aggregation' },
            { evidence_type: 'serious_adverse_event_per_trial', primary_source: 'clinicaltrials_gov', extraction_method: 'source_provided' },
            { evidence_type: 'paper_retraction', primary_source: 'retraction_watch', extraction_method: 'retraction_watch_canonical' },
        ];
        for (const v of variants) {
            const rec = baseRecord({
                evidence_type: v.evidence_type,
                failure: { extraction_method: v.extraction_method, extraction_confidence: 80 },
                provenance: {
                    primary_source: v.primary_source,
                    source_id: 'X',
                    extraction_timestamp: new Date().toISOString(),
                },
            });
            expect(() => gate(rec, NEG_EVIDENCE_SCHEMA, rec.id)).not.toThrow();
        }
    });

    it('typo on evidence_type throws (no silent drop, no silent data loss)', () => {
        setMode(MODE_REJECT);
        const rec = baseRecord({ evidence_type: 'trail_failure' /* typo */ });
        expect(() => gate(rec, NEG_EVIDENCE_SCHEMA, rec.id)).toThrow(/evidence_type/);
    });
});
