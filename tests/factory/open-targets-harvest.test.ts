// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    openTargetsRowToSciweonRecord,
    buildCursorRecord,
} from '../../scripts/factory/lib/open-targets-sql.js';

const BASE_ROW = {
    id: 'CHEMBL1000',
    canonicalSmiles: 'O=C(O)CCC',
    inchiKey: 'KEYABC',
    drugType: 'Small molecule',
    name: 'aspirin',
    parentId: null,
    tradeNames: ['Bayer'],
    synonyms: ['acetylsalicylic acid'],
    crossReferences: [
        { source: 'PubChem', ids: ['2244'] },
        { source: 'DrugBank', ids: ['DB00945'] },
    ],
    childChemblIds: [],
    maximumClinicalStage: 'APPROVAL',
    description: 'Small molecule drug',
};

describe('openTargetsRowToSciweonRecord (PR-OT-3)', () => {
    it('produces Sciweon entity id with ot-drug prefix + ChEMBL ID', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.id).toBe('sciweon::ot-drug::CHEMBL1000');
    });

    it('emits top-level chembl_id matching the OT row id (PR-OT-4 join key)', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.chembl_id).toBe('CHEMBL1000');
    });

    it('populates known_drug_info with snake_case fields per PR-OT-2 contract', () => {
        const rec = openTargetsRowToSciweonRecord(BASE_ROW, '26.03', '2026-05-24');
        expect(rec.known_drug_info).toEqual({
            chembl_id: 'CHEMBL1000',
            name: 'aspirin',
            drug_type: 'Small molecule',
            canonical_smiles: 'O=C(O)CCC',
            inchi_key: 'KEYABC',
            parent_chembl_id: null,
            trade_names: ['Bayer'],
            synonyms: ['acetylsalicylic acid'],
            child_chembl_ids: [],
            max_clinical_stage: 'APPROVAL',
            description: 'Small molecule drug',
        });
    });

    it('normalizes crossReferences to top-level cross_references array', () => {
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

    it('coerces null/undefined OT array fields to empty arrays', () => {
        const rec = openTargetsRowToSciweonRecord(
            { ...BASE_ROW, tradeNames: null, synonyms: undefined, childChemblIds: null, crossReferences: null },
            '26.03', '2026-05-24',
        );
        expect(rec.known_drug_info.trade_names).toEqual([]);
        expect(rec.known_drug_info.synonyms).toEqual([]);
        expect(rec.known_drug_info.child_chembl_ids).toEqual([]);
        expect(rec.cross_references).toEqual([]);
    });

    it('filters malformed crossReferences entries (defensive against schema drift)', () => {
        const rec = openTargetsRowToSciweonRecord(
            {
                ...BASE_ROW,
                crossReferences: [
                    { source: 'PubChem', ids: ['2244'] },
                    { source: null, ids: ['X'] },
                    { source: 'BadIds', ids: 'not-array' },
                    { source: 'EmptyIds', ids: [] },
                    { source: 'WithNulls', ids: ['ok', null, undefined, 123, ''] },
                ],
            },
            '26.03', '2026-05-24',
        );
        expect(rec.cross_references).toEqual([
            { source: 'PubChem', ids: ['2244'] },
            { source: 'WithNulls', ids: ['ok'] },
        ]);
    });

    it('throws on missing/non-string id (would corrupt entity ID deterministic guarantee)', () => {
        expect(() => openTargetsRowToSciweonRecord({ ...BASE_ROW, id: null }, '26.03', '2026-05-24')).toThrow();
        expect(() => openTargetsRowToSciweonRecord({ ...BASE_ROW, id: '' }, '26.03', '2026-05-24')).toThrow();
        expect(() => openTargetsRowToSciweonRecord({}, '26.03', '2026-05-24')).toThrow();
        expect(() => openTargetsRowToSciweonRecord(null, '26.03', '2026-05-24')).toThrow();
    });

    it('preserves optional scalar nulls as null (not undefined) for downstream JSON serialization', () => {
        const rec = openTargetsRowToSciweonRecord(
            { id: 'CHEMBL2', name: null, drugType: null, canonicalSmiles: null, inchiKey: null,
              parentId: null, tradeNames: null, synonyms: null, crossReferences: null,
              childChemblIds: null, maximumClinicalStage: null, description: null },
            '26.03', '2026-05-24',
        );
        expect(rec.known_drug_info.name).toBeNull();
        expect(rec.known_drug_info.drug_type).toBeNull();
        expect(rec.known_drug_info.max_clinical_stage).toBeNull();
        const json = JSON.stringify(rec);
        expect(json).not.toContain('undefined');
    });
});

describe('buildCursorRecord (PR-OT-3)', () => {
    it('emits cursor with schema_version + r2_key + per-release counts', () => {
        const cursor = buildCursorRecord({
            release: '26.03',
            recordCount: 22000,
            byteSizeUncompressed: 50_000_000,
            byteSizeCompressed: 5_000_000,
            ingestedAt: '2026-05-24T10:00:00.000Z',
        });
        expect(cursor).toEqual({
            source: 'open_targets',
            release_version: '26.03',
            last_success_at: '2026-05-24T10:00:00.000Z',
            record_count: 22000,
            byte_size_uncompressed: 50_000_000,
            byte_size_compressed: 5_000_000,
            r2_key: 'processed/bulk/open-targets/26.03/drug-molecule.jsonl.zst',
            schema_version: 'pr-ot-3',
        });
    });

    it('r2_key path interpolates release version (PR-OT-5 cron uses this to compare releases)', () => {
        const cursor = buildCursorRecord({
            release: '27.06', recordCount: 0, byteSizeUncompressed: 0, byteSizeCompressed: 0,
            ingestedAt: '2027-06-15T10:00:00.000Z',
        });
        expect(cursor.r2_key).toBe('processed/bulk/open-targets/27.06/drug-molecule.jsonl.zst');
    });
});
