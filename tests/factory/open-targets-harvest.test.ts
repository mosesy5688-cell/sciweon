// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    openTargetsRowToSciweonRecord,
    buildCursorRecord,
} from '../../scripts/factory/lib/open-targets-sql.js';

// PR-OT-3c input shape: snake_case keys produced by the DuckDB JOIN SQL's
// STRUCT literal aliases (see workflow factory-open-targets-bulk.yml ingest
// job multi-table JOIN step). PR-OT-3 baseline (camelCase OT raw) is no
// longer the contract; case-mapping moved from Node into SQL per
// [[researcher_needs_anchor]] decision 2026-05-24.
const BASE_ROW = {
    id: 'CHEMBL1000',
    canonical_smiles: 'O=C(O)CCC',
    inchi_key: 'KEYABC',
    drug_type: 'Small molecule',
    name: 'aspirin',
    parent_id: null,
    trade_names: ['Bayer'],
    synonyms: ['acetylsalicylic acid'],
    cross_references: [
        { source: 'PubChem', ids: ['2244'] },
        { source: 'DrugBank', ids: ['DB00945'] },
    ],
    child_chembl_ids: [],
    maximum_clinical_stage: 'APPROVAL',
    description: 'Small molecule drug',
    mechanisms: [
        {
            action_type: 'INHIBITOR',
            mechanism: 'Cyclooxygenase inhibitor',
            target_name: 'PTGS1',
            target_type: 'SINGLE PROTEIN',
            targets: ['ENSG00000095303'],
            references: [{ source: 'CHEMBL', ids: ['CHEMBL_ID'], urls: [] }],
        },
    ],
    warnings: [
        {
            warning_type: 'BLACK_BOX_WARNING',
            toxicity_class: 'cardiovascular',
            country: 'United States',
            description: 'Risk of stroke',
            efo_term: 'cerebrovascular accident',
            efo_id: 'EFO_0000712',
            efo_id_for_warning_class: null,
            references: [{ id: 'REF1', source: 'FDA', url: 'http://example.com' }],
        },
    ],
    indications: [
        {
            disease_id: 'EFO_0000400',
            max_clinical_stage: 'APPROVAL',
            trials: [
                {
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
                    url: 'http://clinicaltrials.gov/show/NCT00000001',
                    side_effects: [
                        { disease_id: 'EFO_0001234', disease_from_source: 'Headache' },
                    ],
                },
            ],
        },
    ],
    target_associations: [
        { target_id: 'ENSG00000095303' },
        { target_id: 'ENSG00000073756' },
    ],
};

describe('openTargetsRowToSciweonRecord PR-OT-3c shape', () => {
    it('produces Sciweon entity id with ot-drug prefix + ChEMBL ID', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.id).toBe('sciweon::ot-drug::CHEMBL1000');
    });

    it('emits top-level chembl_id matching the row id (PR-OT-4 join key)', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.chembl_id).toBe('CHEMBL1000');
    });

    it('populates known_drug_info drug-molecule fields with snake_case names', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.known_drug_info.chembl_id).toBe('CHEMBL1000');
        expect(rec.known_drug_info.name).toBe('aspirin');
        expect(rec.known_drug_info.drug_type).toBe('Small molecule');
        expect(rec.known_drug_info.canonical_smiles).toBe('O=C(O)CCC');
        expect(rec.known_drug_info.inchi_key).toBe('KEYABC');
        expect(rec.known_drug_info.parent_chembl_id).toBeNull();
        expect(rec.known_drug_info.trade_names).toEqual(['Bayer']);
        expect(rec.known_drug_info.synonyms).toEqual(['acetylsalicylic acid']);
        expect(rec.known_drug_info.child_chembl_ids).toEqual([]);
        expect(rec.known_drug_info.max_clinical_stage).toBe('APPROVAL');
        expect(rec.known_drug_info.description).toBe('Small molecule drug');
    });

    it('populates known_drug_info.mechanisms[] from drug_mechanism_of_action JOIN', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.known_drug_info.mechanisms).toHaveLength(1);
        expect(rec.known_drug_info.mechanisms[0]).toEqual({
            action_type: 'INHIBITOR',
            mechanism: 'Cyclooxygenase inhibitor',
            target_name: 'PTGS1',
            target_type: 'SINGLE PROTEIN',
            targets: ['ENSG00000095303'],
            references: [{ source: 'CHEMBL', ids: ['CHEMBL_ID'], urls: [] }],
        });
    });

    it('populates known_drug_info.warnings[] from drug_warning JOIN', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.known_drug_info.warnings).toHaveLength(1);
        expect(rec.known_drug_info.warnings[0].warning_type).toBe('BLACK_BOX_WARNING');
        expect(rec.known_drug_info.warnings[0].toxicity_class).toBe('cardiovascular');
        expect(rec.known_drug_info.warnings[0].efo_id).toBe('EFO_0000712');
    });

    it('populates known_drug_info.indications[] with nested trials[] from clinical_indication x clinical_report 2-hop', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.known_drug_info.indications).toHaveLength(1);
        const ind = rec.known_drug_info.indications[0];
        expect(ind.disease_id).toBe('EFO_0000400');
        expect(ind.max_clinical_stage).toBe('APPROVAL');
        expect(ind.trials).toHaveLength(1);
        const trial = ind.trials[0];
        expect(trial.report_id).toBe('NCT00000001');
        expect(trial.trial_phase).toBe('Phase 4');
        expect(trial.trial_overall_status).toBe('Completed');
        expect(trial.year).toBe(2020);
        expect(trial.side_effects).toEqual([
            { disease_id: 'EFO_0001234', disease_from_source: 'Headache' },
        ]);
    });

    it('populates top-level target_associations[] from clinical_target JOIN', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.target_associations).toHaveLength(2);
        expect(rec.target_associations[0]).toEqual({
            target_id: 'ENSG00000095303',
            source: 'open_targets_clinical',
        });
    });

    it('normalizes cross_references to top-level cross_references array', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.cross_references).toEqual([
            { source: 'PubChem', ids: ['2244'] },
            { source: 'DrugBank', ids: ['DB00945'] },
        ]);
    });

    it('stamps license_metadata with cc0-1.0 + release + ingestion date', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.license_metadata).toEqual({
            upstream_source: 'open_targets',
            upstream_license: 'cc0-1.0',
            upstream_release: '26.03',
            ingestion_date: '2026-05-24',
        });
    });

    it('coerces null/undefined aggregated arrays to empty arrays (drugs with no mechanisms/warnings/indications/targets)', () => {
        const rec = openTargetsRowToSciweonRecord(
            { ...BASE_ROW, mechanisms: null, warnings: undefined, indications: null, target_associations: null },
            '26.03', '2026-05-24',
        );
        expect(rec.known_drug_info.mechanisms).toEqual([]);
        expect(rec.known_drug_info.warnings).toEqual([]);
        expect(rec.known_drug_info.indications).toEqual([]);
        expect(rec.target_associations).toEqual([]);
    });

    it('throws on missing/non-string id', () => {
        expect(() => openTargetsRowToSciweonRecord({ ...BASE_ROW, id: null }, '26.03', '2026-05-24')).toThrow();
        expect(() => openTargetsRowToSciweonRecord({ ...BASE_ROW, id: '' }, '26.03', '2026-05-24')).toThrow();
        expect(() => openTargetsRowToSciweonRecord({}, '26.03', '2026-05-24')).toThrow();
        expect(() => openTargetsRowToSciweonRecord(null, '26.03', '2026-05-24')).toThrow();
    });

    it('JSON-serializes without any undefined leaking', () => {
        const rec = openTargetsRowToSciweonRecord(
            { id: 'CHEMBL2', name: null, drug_type: null, canonical_smiles: null, inchi_key: null,
              parent_id: null, trade_names: null, synonyms: null, cross_references: null,
              child_chembl_ids: null, maximum_clinical_stage: null, description: null,
              mechanisms: null, warnings: null, indications: null, target_associations: null },
            '26.03', '2026-05-24',
        );
        const json = JSON.stringify(rec);
        expect(json).not.toContain('undefined');
    });
});

describe('buildCursorRecord PR-OT-3c shape', () => {
    it('emits cursor with PR-OT-3c schema_version + drug-enriched.jsonl.zst r2_key', () => {
        const cursor = buildCursorRecord({
            release: '26.03',
            recordCount: 22230,
            byteSizeUncompressed: 100_000_000,
            byteSizeCompressed: 12_000_000,
            ingestedAt: '2026-05-24T10:00:00.000Z',
        });
        expect(cursor).toEqual({
            source: 'open_targets',
            release_version: '26.03',
            last_success_at: '2026-05-24T10:00:00.000Z',
            record_count: 22230,
            byte_size_uncompressed: 100_000_000,
            byte_size_compressed: 12_000_000,
            r2_key: 'processed/bulk/open-targets/26.03/drug-enriched.jsonl.zst',
            schema_version: 'pr-ot-3c',
        });
    });

    it('r2_key path interpolates release version (PR-OT-5 cron uses this to compare releases)', () => {
        const cursor = buildCursorRecord({
            release: '27.06', recordCount: 0, byteSizeUncompressed: 0, byteSizeCompressed: 0,
            ingestedAt: '2027-06-15T10:00:00.000Z',
        });
        expect(cursor.r2_key).toBe('processed/bulk/open-targets/27.06/drug-enriched.jsonl.zst');
    });
});
