// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    mapMechanism, mapWarning, mapIndication,
    mapTrial, mapTargetAssociation,
} from '../../scripts/factory/lib/open-targets-aggregator.js';

describe('mapMechanism (drug_mechanism_of_action row -> Sciweon mechanism)', () => {
    it('maps a full row to all 6 fields', () => {
        const m = mapMechanism({
            action_type: 'INHIBITOR',
            mechanism: 'COX-1 inhibitor',
            target_name: 'PTGS1',
            target_type: 'SINGLE PROTEIN',
            targets: ['ENSG00000095303'],
            references: [{ source: 'CHEMBL', ids: ['CHEMBL_X'], urls: [] }],
        });
        expect(m).toEqual({
            action_type: 'INHIBITOR',
            mechanism: 'COX-1 inhibitor',
            target_name: 'PTGS1',
            target_type: 'SINGLE PROTEIN',
            targets: ['ENSG00000095303'],
            references: [{ source: 'CHEMBL', ids: ['CHEMBL_X'], urls: [] }],
        });
    });

    it('nulls non-string fields and empties non-array fields', () => {
        const m = mapMechanism({});
        expect(m.action_type).toBeNull();
        expect(m.targets).toEqual([]);
        expect(m.references).toEqual([]);
    });

    it('returns null for non-object input (so caller can filter)', () => {
        expect(mapMechanism(null)).toBeNull();
        expect(mapMechanism(undefined)).toBeNull();
        expect(mapMechanism('string')).toBeNull();
    });

    it('drops non-string entries from targets', () => {
        const m = mapMechanism({ targets: ['ok', null, 123, '', 'ENSG1'] });
        expect(m.targets).toEqual(['ok', 'ENSG1']);
    });
});

describe('mapWarning (drug_warning row -> Sciweon warning)', () => {
    it('maps a full row preserving structured references[] verbatim', () => {
        const w = mapWarning({
            warning_type: 'BLACK_BOX_WARNING',
            toxicity_class: 'cardiovascular',
            country: 'US',
            description: 'Risk of stroke',
            efo_term: 'stroke',
            efo_id: 'EFO_X',
            efo_id_for_warning_class: 'EFO_Y',
            references: [{ id: 'R1', source: 'FDA', url: 'http://example.com' }],
        });
        expect(w.warning_type).toBe('BLACK_BOX_WARNING');
        expect(w.efo_id).toBe('EFO_X');
        expect(w.efo_id_for_warning_class).toBe('EFO_Y');
        expect(w.references).toEqual([{ id: 'R1', source: 'FDA', url: 'http://example.com' }]);
    });

    it('handles minimal row (only warning_type) with null defaults', () => {
        const w = mapWarning({ warning_type: 'WITHDRAWN' });
        expect(w.warning_type).toBe('WITHDRAWN');
        expect(w.toxicity_class).toBeNull();
        expect(w.country).toBeNull();
        expect(w.references).toEqual([]);
    });

    it('returns null for non-object input', () => {
        expect(mapWarning(null)).toBeNull();
    });
});

describe('mapIndication (clinical_indication row + nested trials[] -> Sciweon indication)', () => {
    it('maps disease_id + max_clinical_stage + trials[] together', () => {
        const ind = mapIndication({
            disease_id: 'EFO_0000400',
            max_clinical_stage: 'APPROVAL',
            trials: [
                { report_id: 'NCT1', trial_phase: 'Phase 4', year: 2020 },
            ],
        });
        expect(ind.disease_id).toBe('EFO_0000400');
        expect(ind.max_clinical_stage).toBe('APPROVAL');
        expect(ind.trials).toHaveLength(1);
        expect(ind.trials[0].report_id).toBe('NCT1');
        expect(ind.trials[0].trial_phase).toBe('Phase 4');
    });

    it('rejects rows with missing disease_id (researcher-need: indication must have disease anchor)', () => {
        expect(mapIndication({ disease_id: null, trials: [] })).toBeNull();
        expect(mapIndication({})).toBeNull();
        expect(mapIndication({ disease_id: '' })).toBeNull();
    });

    it('coerces missing/null trials to empty array (indication without clinical reports is still valid)', () => {
        const ind = mapIndication({ disease_id: 'EFO_X' });
        expect(ind.trials).toEqual([]);
    });

    it('filters malformed trials (e.g. report_id null) from the nested array', () => {
        const ind = mapIndication({
            disease_id: 'EFO_X',
            trials: [
                { report_id: 'NCT1' },
                { report_id: null },
                { report_id: 'NCT2' },
            ],
        });
        expect(ind.trials).toHaveLength(2);
        expect(ind.trials.map(t => t.report_id)).toEqual(['NCT1', 'NCT2']);
    });
});

describe('mapTrial (clinical_report row -> Sciweon trial nested under indication)', () => {
    it('preserves all 12 selected fields (subset of OT clinical_report 24-col schema)', () => {
        const t = mapTrial({
            report_id: 'NCT00000001',
            trial_phase: 'Phase 4',
            trial_clinical_stage: 'PHASE_4',
            trial_phase_from_source: 'Phase 4',
            trial_overall_status: 'Completed',
            year: 2020,
            trial_official_title: 'Aspirin in CV prevention',
            trial_why_stopped: null,
            trial_study_type: 'INTERVENTIONAL',
            trial_primary_purpose: 'PREVENTION',
            url: 'http://example.com/NCT00000001',
            side_effects: [{ disease_id: 'EFO_HEADACHE' }],
        });
        expect(t.report_id).toBe('NCT00000001');
        expect(t.trial_overall_status).toBe('Completed');
        expect(t.year).toBe(2020);
        expect(t.side_effects).toEqual([{ disease_id: 'EFO_HEADACHE' }]);
    });

    it('coerces non-numeric year to null', () => {
        const t = mapTrial({ report_id: 'NCT1', year: 'twenty-twenty' });
        expect(t.year).toBeNull();
    });

    it('rejects trials missing report_id (researcher-need: trial must have report anchor)', () => {
        expect(mapTrial({ report_id: null })).toBeNull();
        expect(mapTrial({})).toBeNull();
        expect(mapTrial({ report_id: '' })).toBeNull();
    });

    it('preserves side_effects[] STRUCT shape verbatim (PR-OT-4 NegEvidence DB consumes this)', () => {
        const t = mapTrial({
            report_id: 'NCT1',
            side_effects: [
                { disease_id: 'EFO_X', disease_from_source: 'X', frequency: 'common' },
            ],
        });
        expect(t.side_effects[0]).toEqual({
            disease_id: 'EFO_X', disease_from_source: 'X', frequency: 'common',
        });
    });
});

describe('mapTargetAssociation (clinical_target row -> Sciweon target_association)', () => {
    it('maps target_id + stamps source=open_targets_clinical', () => {
        const ta = mapTargetAssociation({ target_id: 'ENSG00000095303' });
        expect(ta).toEqual({
            target_id: 'ENSG00000095303',
            source: 'open_targets_clinical',
        });
    });

    it('rejects rows with missing target_id', () => {
        expect(mapTargetAssociation({ target_id: null })).toBeNull();
        expect(mapTargetAssociation({})).toBeNull();
        expect(mapTargetAssociation({ target_id: '' })).toBeNull();
    });
});
