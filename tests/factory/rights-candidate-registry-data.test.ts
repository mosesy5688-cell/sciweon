/**
 * Lane 4 -- registry data tests.
 *
 * Covers brief tests 2 (the frozen 25 and their partition), 11 (the complete
 * obligation set, EIGHT ids), 12 (binding the plane counts to LICENSE) and
 * 13 (the PubChem plane record and the public-label rule).
 *
 * The partition asserted here is a LOGICAL PARTITION: three arrays returned
 * from one module, in one process, in one heap. These are logical-partition
 * tests and do not prove anything about a packaged artifact.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    count,
    snapshot,
    planeRecord,
    planeIds,
    allObligations,
    obligationsForPlane,
    moduleLimits,
    sourcesWithoutPlaneMembership,
    isSourceWithoutPlaneMembership,
    has,
    planeOf,
} from '../../scripts/factory/lib/rights-candidate-registry-data.js';

const LICENSE_TEXT = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');

/** The eight obligation ids of brief section 4, read as EIGHT per L4-1. */
const EXPECTED_OBLIGATION_IDS = [
    'ATTRIBUTION_REQUIRED_PUBCHEM_NIH_NCBI',
    'DEPOSITOR_CONTRIBUTED_TERMS_MAY_APPLY',
    'ATTRIBUTION_REQUIRED_EMBL_EBI',
    'SHARE_ALIKE_CC_BY_SA_3_0_UNPORTED',
    'COLLECTION_VS_ADAPTATION_BOUNDARY_REVIEW_REQUIRED',
    'ATTRIBUTION_REQUIRED_NLM_COURTESY',
    'CURRENCY_DISCLOSURE_REQUIRED_ON_REPUBLICATION',
    'COMPLY_WITH_MOST_RESTRICTIVE_UPSTREAM_TERMS',
];

function licenseNumber(pattern: RegExp): number {
    const matched = LICENSE_TEXT.match(pattern);
    expect(matched, `LICENSE did not match ${pattern}`).not.toBeNull();
    return Number((matched as RegExpMatchArray)[1]);
}

describe('test 2 -- the frozen 25 and their partition', () => {
    it('is exactly 25 pairs, 5 / 14 / 6 by plane', () => {
        const c = count();
        expect(c.total).toBe(25);
        expect(c.by_plane).toEqual({
            CLEAN_COMMERCIAL: 5,
            LICENSED_SHAREALIKE: 14,
            BIBLIOGRAPHIC: 6,
        });
        expect(snapshot()).toHaveLength(25);
        expect(5 + 14 + 6).toBe(25);
    });

    it('no field name appears in two planes, and none repeats within one', () => {
        const rows = snapshot();
        const names = rows.map((r) => r.field);
        expect(new Set(names).size).toBe(25);
        for (const planeId of planeIds()) {
            const record = planeRecord(planeId);
            expect(record).not.toBeNull();
            const fields = (record as { fields: string[] }).fields;
            expect(new Set(fields).size).toBe(fields.length);
        }
    });

    it('carries the exact Gate-5B names, per plane, in order', () => {
        expect((planeRecord('CLEAN_COMMERCIAL') as { fields: string[] }).fields).toEqual([
            'pubchem_cid', 'inchi_key', 'molecular_formula',
            'connectivity_smiles', 'iupac_name',
        ]);
        expect((planeRecord('LICENSED_SHAREALIKE') as { fields: string[] }).fields).toEqual([
            'chembl_db_version', 'chembl_release_date', 'chembl_target_id',
            'chembl_id', 'assay_chembl_id', 'assay_description',
            'assay_organism', 'standard_type', 'standard_relation',
            'standard_value', 'standard_units', 'pchembl_value',
            'source_record_activity_id', 'document_chembl_id',
        ]);
        expect((planeRecord('BIBLIOGRAPHIC') as { fields: string[] }).fields).toEqual([
            'pmid', 'doi', 'journal', 'pubdate', 'volume', 'pages',
        ]);
    });

    it('keys on the pair -- no lookup can take a field alone', () => {
        expect(has('chembl', 'chembl_id')).toBe(true);
        expect(has('unichem', 'chembl_id')).toBe(false);
        expect(has('pubmed', 'chembl_id')).toBe(false);
        expect(planeOf('unichem', 'chembl_id')).toBeNull();
        expect((has as (...a: unknown[]) => boolean).length).toBe(2);
        expect((planeOf as (...a: unknown[]) => unknown).length).toBe(2);
    });

    it('freezes the second list -- the four sources with no plane membership', () => {
        expect(sourcesWithoutPlaneMembership()).toEqual([
            'uniprot', 'unichem', 'meddra', 'kegg',
        ]);
        for (const source of ['uniprot', 'unichem', 'meddra', 'kegg']) {
            expect(isSourceWithoutPlaneMembership(source)).toBe(true);
        }
        expect(isSourceWithoutPlaneMembership('pubchem')).toBe(false);
        expect(isSourceWithoutPlaneMembership(null as unknown as string)).toBe(false);
    });
});

describe('test 11 -- the complete obligation set, EIGHT ids', () => {
    it('declares exactly eight distinct obligation ids', () => {
        const ids = allObligations().map((o) => o.id);
        expect(ids).toHaveLength(8);
        expect(new Set(ids).size).toBe(8);
        expect([...ids].sort()).toEqual([...EXPECTED_OBLIGATION_IDS].sort());
        expect(2 + 3 + 2 + 1).toBe(8);
    });

    it('every obligation is declared, never executed', () => {
        for (const o of allObligations()) {
            expect(o.enforced, o.id).toBe(false);
            expect(o.discharged_by_this_module, o.id).toBe(false);
        }
    });

    it('attaches the right obligations per plane, plus the plane-independent one', () => {
        expect(obligationsForPlane('CLEAN_COMMERCIAL').map((o) => o.id)).toEqual([
            'ATTRIBUTION_REQUIRED_PUBCHEM_NIH_NCBI',
            'DEPOSITOR_CONTRIBUTED_TERMS_MAY_APPLY',
            'COMPLY_WITH_MOST_RESTRICTIVE_UPSTREAM_TERMS',
        ]);
        expect(obligationsForPlane('LICENSED_SHAREALIKE').map((o) => o.id)).toEqual([
            'ATTRIBUTION_REQUIRED_EMBL_EBI',
            'SHARE_ALIKE_CC_BY_SA_3_0_UNPORTED',
            'COLLECTION_VS_ADAPTATION_BOUNDARY_REVIEW_REQUIRED',
            'COMPLY_WITH_MOST_RESTRICTIVE_UPSTREAM_TERMS',
        ]);
        expect(obligationsForPlane('BIBLIOGRAPHIC').map((o) => o.id)).toEqual([
            'ATTRIBUTION_REQUIRED_NLM_COURTESY',
            'CURRENCY_DISCLOSURE_REQUIRED_ON_REPUBLICATION',
            'COMPLY_WITH_MOST_RESTRICTIVE_UPSTREAM_TERMS',
        ]);
        expect(obligationsForPlane('NO_SUCH_PLANE')).toEqual([]);
    });

    it('the share-alike separation obligation does not assert a settled boundary', () => {
        const found = allObligations().find(
            (o) => o.id === 'COLLECTION_VS_ADAPTATION_BOUNDARY_REVIEW_REQUIRED',
        );
        expect(found).toBeDefined();
        expect((found as { boundary_settled: boolean }).boundary_settled).toBe(false);
    });

    it('module_limits reports not-end-to-end, not-wired-to-serving, not-wired-to-packaging', () => {
        expect(moduleLimits()).toEqual({
            separation_model: 'LOGICAL_PARTITION',
            separation_proven_by_packaging_artifact: false,
            packaging_cross_plane_rejection_tests_present: false,
            end_to_end: false,
            wired_to_serving_path: false,
            wired_to_packaging_path: false,
        });
    });
});

describe('test 12 -- plane counts bound to LICENSE', () => {
    /**
     * LIMIT, stated: this binds COUNTS ONLY. LICENSE publishes the numbers,
     * not the names, so it detects a cardinality change and NOT a
     * transposition. The sorted (source, field, plane) content hash in the PR
     * body is what covers transposition.
     */
    it('the 5 / 14 / 6 = 25 counts match the numbers LICENSE publishes', () => {
        const c = count();
        expect(licenseNumber(/(\d+)\s+named PubChem fields/)).toBe(c.by_plane.CLEAN_COMMERCIAL);
        expect(licenseNumber(/(\d+)\s+named ChEMBL fields/)).toBe(c.by_plane.LICENSED_SHAREALIKE);
        expect(licenseNumber(/(\d+)\s+named PubMed fields/)).toBe(c.by_plane.BIBLIOGRAPHIC);
        expect(licenseNumber(/frozen set of (\d+) rights-bearing FIELDS/)).toBe(c.total);
    });
});

describe('test 13 -- the PubChem plane record and the public label', () => {
    it('carries CLEAN_COMMERCIAL_FIELD_QUALIFIED and no unconditional commercial grant', () => {
        const record = planeRecord('CLEAN_COMMERCIAL') as {
            rights_state: string;
            grants_unconditional_commercial_use: boolean;
            public_label: string;
            source: string;
        };
        expect(record.source).toBe('pubchem');
        expect(record.rights_state).toBe('CLEAN_COMMERCIAL_FIELD_QUALIFIED');
        expect(record.grants_unconditional_commercial_use).toBe(false);
        expect(record.public_label).toBe('FIELD-QUALIFIED PUBLIC');
        expect(LICENSE_TEXT).toContain('FIELD-QUALIFIED PUBLIC');
    });

    it('no plane grants unconditional commercial use', () => {
        for (const planeId of planeIds()) {
            const record = planeRecord(planeId) as { grants_unconditional_commercial_use: boolean };
            expect(record.grants_unconditional_commercial_use, planeId).toBe(false);
        }
    });

    it('no rights state anywhere equals the bare plane id CLEAN_COMMERCIAL', () => {
        for (const row of snapshot()) {
            expect(row.rights_state).not.toBe('CLEAN_COMMERCIAL');
        }
        for (const planeId of planeIds()) {
            const record = planeRecord(planeId) as { rights_state: string; public_label: string };
            expect(record.rights_state).not.toBe('CLEAN_COMMERCIAL');
            expect(record.public_label).not.toBe('CLEAN_COMMERCIAL');
        }
    });

    it('the aggregate guard returns the obligations alongside the count', () => {
        const c = count();
        expect(Array.isArray(c.obligations)).toBe(true);
        expect(c.obligations).toHaveLength(8);
        expect(Object.keys(c).sort()).toEqual(['by_plane', 'obligations', 'total']);
    });
});
