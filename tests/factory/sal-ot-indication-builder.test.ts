// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    joinIndicationToAssertion, BUILDER_LABEL, ASSERTION_CLASS, PREDICATE_TREATS,
} from '../../scripts/factory/lib/sal-ot-indication-builder.js';
import {
    computeSalDeterministicUuid, NAMESPACE_SCIWEON_SAL,
} from '../../scripts/factory/lib/sid-sal-stamping.js';
import { generateSID_S } from '../../scripts/factory/lib/sid-generator.js';

// Production-anchored test fixtures (R2 probe 2026-05-25 of compounds-enriched.jsonl
// from F3 run 26397449808 — CHEMBL292687 first indication EFO_0000764)
const CHEMBL_ID = 'CHEMBL292687';
const COMPOUND_SID = 'c78a5614b42f2f8bce2e7b870e4ed16d';
const RAW_DISEASE_ID = 'EFO_0000764';
const DISEASE_SID = '3c653786fb5e7f7881843d454921ad5c';
// Frozen pin verified via execution-gate Node compute pre-commit (2026-05-25)
const FROZEN_UUID = '30651720-1380-50a5-b7ac-656be838c0dd';
const FROZEN_SAL_SID_S = 'd9563d265e9652365e3044f06f0e0808';

function makeMaps() {
    return {
        compoundSidMap: new Map([[CHEMBL_ID, COMPOUND_SID]]),
        diseaseSidMap: new Map([[RAW_DISEASE_ID, DISEASE_SID]]),
        compoundLabelMap: new Map([[CHEMBL_ID, 'Some Drug']]),
        diseaseLabelMap: new Map([[RAW_DISEASE_ID, 'B-cell acute lymphoblastic leukemia']]),
    };
}

function makeCompound(overrides = {}) {
    return { id: 'sciweon::compound::CID:6', chembl_id: CHEMBL_ID, ...overrides };
}
function makeIndication(overrides = {}) {
    return { disease_id: RAW_DISEASE_ID, max_clinical_stage: 4, trials: [], ...overrides };
}

describe('Constants lock', () => {
    it('BUILDER_LABEL', () => { expect(BUILDER_LABEL).toBe('SAL-OT-INDICATION-BUILDER'); });
    it('ASSERTION_CLASS = clinical_indication', () => { expect(ASSERTION_CLASS).toBe('clinical_indication'); });
    it('PREDICATE_TREATS = treats (deterministic, Layer 1 ignores clinical_stage)', () => {
        expect(PREDICATE_TREATS).toBe('treats');
    });
});

describe('joinIndicationToAssertion — full happy path', () => {
    it('emits assertion with all 5 payload fields + display_context', () => {
        const m = makeMaps();
        const r = joinIndicationToAssertion(makeCompound(), makeIndication(), m.compoundSidMap, m.diseaseSidMap, m.compoundLabelMap, m.diseaseLabelMap);
        expect(r.skip).toBeUndefined();
        expect(r.assertion.assertion_class).toBe(ASSERTION_CLASS);
        expect(r.assertion.subject_canonical_sid).toBe(COMPOUND_SID);
        expect(r.assertion.predicate).toBe(PREDICATE_TREATS);
        expect(r.assertion.object_canonical_sid).toBe(DISEASE_SID);
        expect(r.assertion.primary_source).toBe(`opentargets_indication:${CHEMBL_ID}_${RAW_DISEASE_ID}`);
        expect(r.assertion.source_record_id).toBe('sciweon::compound::CID:6::sciweon::disease::efo:0000764');
        expect(r.assertion.display_context.subject_label).toBe('Some Drug');
        expect(r.assertion.display_context.object_label).toBe('B-cell acute lymphoblastic leukemia');
    });
});

describe('joinIndicationToAssertion — 5 skip buckets (Plan A1 telemetry)', () => {
    const m = makeMaps();

    it('missing compound.chembl_id -> missing_compound_chembl_id', () => {
        const r = joinIndicationToAssertion({ id: 'x' }, makeIndication(), m.compoundSidMap, m.diseaseSidMap);
        expect(r.skip).toBe('missing_compound_chembl_id');
    });
    it('chembl_id not in compoundSidMap -> missing_compound_sid', () => {
        const r = joinIndicationToAssertion(makeCompound({ chembl_id: 'CHEMBL999999' }), makeIndication(), m.compoundSidMap, m.diseaseSidMap);
        expect(r.skip).toBe('missing_compound_sid');
    });
    it('indication missing disease_id -> missing_indication_disease_id', () => {
        const r = joinIndicationToAssertion(makeCompound(), { max_clinical_stage: 1 }, m.compoundSidMap, m.diseaseSidMap);
        expect(r.skip).toBe('missing_indication_disease_id');
    });
    it('unparseable disease_id (no underscore) -> unparseable_disease_id', () => {
        const r = joinIndicationToAssertion(makeCompound(), { disease_id: 'no-underscore' }, m.compoundSidMap, m.diseaseSidMap);
        expect(r.skip).toBe('unparseable_disease_id');
    });
    it('disease_id parses but missing from diseaseSidMap (OT orphan ref) -> missing_disease_sid', () => {
        const r = joinIndicationToAssertion(makeCompound(), { disease_id: 'MONDO_9999999' }, m.compoundSidMap, m.diseaseSidMap);
        expect(r.skip).toBe('missing_disease_sid');
    });
});

describe('Frozen UUID v5 + SAL sid_s pin (production-anchored CHEMBL292687 treats EFO_0000764)', () => {
    it('canonical payload derives pinned UUID v5', () => {
        const m = makeMaps();
        const r = joinIndicationToAssertion(makeCompound(), makeIndication(), m.compoundSidMap, m.diseaseSidMap, m.compoundLabelMap, m.diseaseLabelMap);
        // Normalize payload per sid-sal-stamping classifier (lowercased + trimmed + sorted)
        const normalized = {
            assertion_class: r.assertion.assertion_class.toLowerCase(),
            subject_canonical_sid: r.assertion.subject_canonical_sid.toLowerCase(),
            predicate: r.assertion.predicate.toLowerCase(),
            object_canonical_sid: r.assertion.object_canonical_sid.toLowerCase(),
            primary_source: r.assertion.primary_source.toLowerCase(),
        };
        const uuid = computeSalDeterministicUuid(normalized);
        expect(uuid).toBe(FROZEN_UUID);
    });

    it('SAL sid_s derives from UUID via established formula', () => {
        const salSidS = generateSID_S('sal_assertion', `assertion_uuid:${FROZEN_UUID}`, 'sal.uuid.v1.0');
        expect(salSidS).toBe(FROZEN_SAL_SID_S);
    });

    it('NAMESPACE_SCIWEON_SAL still pinned (cross-PR continuity)', () => {
        expect(NAMESPACE_SCIWEON_SAL).toBe('0032aae1-052d-5d09-97b1-5c5b091015dd');
    });

    it('disease.sid_s for EFO_0000764 derives via disease.efo.v1.0 canon', () => {
        expect(generateSID_S('disease', 'efo:0000764', 'disease.efo.v1.0')).toBe(DISEASE_SID);
    });
});
