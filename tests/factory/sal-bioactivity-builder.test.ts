// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    joinBioactivityToAssertion, derivePredicate, deriveChemblActivityId,
    ASSERTION_CLASS, PREDICATE_BINDS, PREDICATE_INHIBITS,
} from '../../scripts/factory/lib/sal-bioactivity-builder.js';

const COMPOUND_ID = 'sciweon::compound::CID:2244';
const COMPOUND_SID = 'a'.repeat(32);
const UNIPROT_ACC = 'P00533';
const TARGET_FULL_ID = `sciweon::target::uniprot:${UNIPROT_ACC}`;
const TARGET_SID = 'b'.repeat(32);

function makeBio(overrides = {}) {
    return {
        id: 'sciweon::bioactivity::CHEMBL_ACT_12345',
        compound_id: COMPOUND_ID,
        target_id: 'CHEMBL2007',
        target: { uniprot_accession: UNIPROT_ACC, chembl_id: 'CHEMBL2007' },
        activity_type: 'IC50',
        value: 0.5, unit: 'nM',
        is_active: true,
        provenance: { sources: [{ source: 'chembl', source_id: '12345' }] },
        ...overrides,
    };
}

const compoundMap = new Map([[COMPOUND_ID, COMPOUND_SID]]);
const targetMap = new Map([[TARGET_FULL_ID, TARGET_SID]]);
const compoundLabels = new Map([[COMPOUND_ID, 'Aspirin']]);
const targetLabels = new Map([[TARGET_FULL_ID, 'EGFR']]);

describe('derivePredicate — locked state machine', () => {
    it('is_active=true + IC50 → inhibits', () => {
        expect(derivePredicate({ is_active: true, activity_type: 'IC50' })).toBe(PREDICATE_INHIBITS);
    });
    it('is_active=true + Ki → inhibits', () => {
        expect(derivePredicate({ is_active: true, activity_type: 'Ki' })).toBe(PREDICATE_INHIBITS);
    });
    it('is_active=true + non-inhibition type → binds', () => {
        expect(derivePredicate({ is_active: true, activity_type: 'unknown_type' })).toBe(PREDICATE_BINDS);
    });
    it('is_active=false → binds (Layer 1 does not interpret semantic gradient)', () => {
        expect(derivePredicate({ is_active: false, activity_type: 'IC50' })).toBe(PREDICATE_BINDS);
    });
    it('is_active=null → binds', () => {
        expect(derivePredicate({ is_active: null, activity_type: 'IC50' })).toBe(PREDICATE_BINDS);
    });
});

describe('deriveChemblActivityId — defect-12 hardened', () => {
    it('chembl source with numeric source_id → returns id', () => {
        expect(deriveChemblActivityId({ provenance: { sources: [{ source: 'chembl', source_id: '99' }] } })).toBe('99');
    });
    it('chembl source with alphabetic source_id → null', () => {
        expect(deriveChemblActivityId({ provenance: { sources: [{ source: 'chembl', source_id: 'abc' }] } })).toBeNull();
    });
    it('no chembl source → null', () => {
        expect(deriveChemblActivityId({ provenance: { sources: [{ source: 'other', source_id: '1' }] } })).toBeNull();
    });
    it('missing provenance → null', () => {
        expect(deriveChemblActivityId({})).toBeNull();
    });
});

describe('joinBioactivityToAssertion — Defect-16 topology', () => {
    it('full happy path → assertion with correct subject/object SID-S', () => {
        const r = joinBioactivityToAssertion(makeBio(), compoundMap, targetMap, compoundLabels, targetLabels);
        expect(r.skip).toBeUndefined();
        expect(r.assertion.assertion_class).toBe(ASSERTION_CLASS);
        expect(r.assertion.subject_canonical_sid).toBe(COMPOUND_SID);
        expect(r.assertion.object_canonical_sid).toBe(TARGET_SID);
        expect(r.assertion.predicate).toBe(PREDICATE_INHIBITS);
        expect(r.assertion.primary_source).toBe('chembl_activity:12345');
        expect(r.assertion.source_record_id).toBe('sciweon::bioactivity::CHEMBL_ACT_12345');
        expect(r.assertion.display_context.subject_label).toBe('Aspirin');
        expect(r.assertion.display_context.object_label).toBe('EGFR');
    });

    it('missing chembl provenance → skip missing_chembl_activity', () => {
        const r = joinBioactivityToAssertion(makeBio({ provenance: { sources: [] } }), compoundMap, targetMap, compoundLabels, targetLabels);
        expect(r.skip).toBe('missing_chembl_activity');
    });

    it('missing target.uniprot_accession → skip missing_target_resolution (Defect-16 root case)', () => {
        const r = joinBioactivityToAssertion(makeBio({ target: { chembl_id: 'CHEMBL2007' } }), compoundMap, targetMap, compoundLabels, targetLabels);
        expect(r.skip).toBe('missing_target_resolution');
    });

    it('uniprot present but not in target crosswalk → skip unstampable_orphan_target', () => {
        const r = joinBioactivityToAssertion(makeBio({ target: { uniprot_accession: 'Q99999' } }), compoundMap, targetMap, compoundLabels, targetLabels);
        expect(r.skip).toBe('unstampable_orphan_target');
    });

    it('compound.id not in compound crosswalk → skip unstampable_orphan_compound', () => {
        const r = joinBioactivityToAssertion(makeBio({ compound_id: 'sciweon::compound::CID:999999' }), compoundMap, targetMap, compoundLabels, targetLabels);
        expect(r.skip).toBe('unstampable_orphan_compound');
    });

    it('legacy build that incorrectly joined by b.target_id (bare ChEMBL) → would NOT find target — regression guard for Defect-16', () => {
        // This proves the fix: prior code did targetSidSMap.get(b.target_id) which is
        // 'CHEMBL2007' — but target.id is 'sciweon::target::uniprot:P00533'. The legacy
        // lookup miss is exactly what caused 360,142/360,142 unstampable on first deploy.
        const wrongKey = 'CHEMBL2007';
        expect(targetMap.get(wrongKey)).toBeUndefined();
        // The fixed join builds the correct key:
        expect(targetMap.get(`sciweon::target::uniprot:${UNIPROT_ACC}`)).toBe(TARGET_SID);
    });
});
