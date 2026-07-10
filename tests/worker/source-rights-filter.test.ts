/**
 * RC-3A (D-132G) unit tests for the shared source-rights containment filter.
 *
 * Gates covered here:
 *   15  representative restricted values (MedDRA PT "ACUTE KIDNEY INJURY";
 *       KEGG xref "D00109") are absent from the filtered output AND the
 *       additive rights-withheld marker is present.
 *   16  an open-source-only compound (PubChem / FDA / ChEMBL) is structurally
 *       unchanged and carries NO marker.
 *   4/6 restricted evidence stays represented (signal preserved), only the
 *       proprietary label is withheld -- never converted to no-evidence.
 */

import { describe, it, expect } from 'vitest';
import { applySourceRightsFilter } from '../../src/worker/lib/source-rights-filter';

const MEDDRA_PT = 'ACUTE KIDNEY INJURY';
const MEDDRA_SLUG = 'acute_kidney_injury';
const KEGG_ID = 'D00109';
const WITHHELD = 'withheld_by_rights_policy';

function negResponse() {
    return {
        compound: { id: 'sciweon::compound::CID:2244', url: 'https://sciweon.com/api/v1/entity/x' },
        snapshot_date: '2026-05-16',
        negative_signals_count: 2,
        signals_by_severity: { critical: 1, major: 0, minor: 0, unknown: 1 },
        signals: [
            {
                id: 'sciweon::neg::faers::CID:2244::acute_kidney_injury',
                url: 'https://sciweon.com/api/v1/entity/sciweon%3A%3Aneg%3A%3Afaers%3A%3ACID%3A2244%3A%3Aacute_kidney_injury',
                evidence_type: 'faers_adr_signal', severity: 'critical', reason_category: 'meddra_pt_adr',
                confidence: 85, subject: { compound_id: 'sciweon::compound::CID:2244' },
                detail: { meddra_pt: MEDDRA_PT, report_count: 15000, unii: 'R16CO5Y76E' },
                provenance: { primary_source: 'openfda_faers', source_id: 'R16CO5Y76E' },
            },
            {
                id: 'sciweon::neg::trial_failure::NCT04123456', url: 'https://sciweon.com/api/v1/entity/y',
                evidence_type: 'trial_failure', severity: 'unknown',
                subject: { compound_id: 'sciweon::compound::CID:2244' }, detail: {},
                provenance: { primary_source: 'clinicaltrials_gov' },
            },
        ],
    };
}

describe('applySourceRightsFilter - MedDRA in negative evidence', () => {
    it('withholds the MedDRA PT + id slug but keeps the adverse-event signal', () => {
        const input = negResponse();
        const { filtered, withheld } = applySourceRightsFilter(input);
        const json = JSON.stringify(filtered);
        expect(json).not.toContain(MEDDRA_PT);
        expect(json).not.toContain(MEDDRA_SLUG);
        expect(json.toLowerCase()).not.toContain('acute');

        const faers = filtered.signals[0] as any;
        expect(faers.detail.meddra_pt).toBeUndefined();
        // signal is STILL represented (never converted to no-evidence).
        expect(faers.detail.report_count).toBe(15000);
        expect(faers.severity).toBe('critical');
        expect(faers.provenance.primary_source).toBe('openfda_faers');
        expect(faers.source_visibility_state).toBe(WITHHELD);
        expect(faers.source_family).toBe('meddra');
        expect(faers.id).toMatch(/^sciweon::neg::faers::CID:2244::rwh_[0-9a-f]{8}$/);
        expect(faers.url).not.toContain(MEDDRA_SLUG);

        // non-MedDRA signal is untouched.
        expect((filtered.signals[1] as any).id).toBe('sciweon::neg::trial_failure::NCT04123456');
        expect((filtered.signals[1] as any).source_visibility_state).toBeUndefined();

        // aggregate semantics unchanged; additive marker present.
        expect(filtered.negative_signals_count).toBe(2);
        expect(withheld).toEqual({ meddra: 1, kegg: 0 });
        expect((filtered as any).source_visibility.withheld).toContainEqual(
            { source_visibility_state: WITHHELD, source_family: 'meddra', withheld_item_count: 1 },
        );
    });

    it('does not mutate the input object (clone-safe)', () => {
        const input = negResponse();
        applySourceRightsFilter(input);
        expect(input.signals[0].detail.meddra_pt).toBe(MEDDRA_PT);
        expect((input as any).source_visibility).toBeUndefined();
    });
});

describe('applySourceRightsFilter - compound record (MedDRA + KEGG)', () => {
    function compound() {
        return {
            id: 'sciweon::compound::CID:2244',
            compound: {
                pubchem_cid: 2244, chembl_id: 'CHEMBL25', inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
                external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945', kegg_drug_id: KEGG_ID, rxcui: '1191' },
                kegg_drug: { d_number: KEGG_ID, pathways: ['hsa04610'], diseases: [{ indication: 'x', kegg_disease_id: 'H00001' }] },
                fda_signals: {
                    has_boxed_warning: true, boxed_warning_text: 'FDA MANDATED WARNING',
                    faers_top_adr_terms: [{ term: MEDDRA_PT, count: 15000 }, { term: 'HEPATIC FAILURE', count: 900 }],
                    faers_total_top_count: 15900,
                },
                _tier: 'T1',
            },
        };
    }

    it('withholds kegg_drug, kegg_drug_id and faers_top_adr_terms; keeps FDA + structural fields', () => {
        const { filtered, withheld } = applySourceRightsFilter(compound());
        const json = JSON.stringify(filtered);
        expect(json).not.toContain(MEDDRA_PT);
        expect(json).not.toContain('HEPATIC FAILURE');
        expect(json).not.toContain(KEGG_ID);
        expect(json).not.toContain('H00001');

        const c = filtered.compound as any;
        expect(c.kegg_drug).toBeUndefined();
        expect(c.kegg_drug_visibility.source_family).toBe('kegg');
        expect(c.external_ids.kegg_drug_id).toBeUndefined();
        expect(c.external_ids.kegg_drug_id_visibility).toBe(WITHHELD);
        // non-KEGG xrefs untouched.
        expect(c.external_ids.unii).toBe('R16CO5Y76E');
        expect(c.external_ids.drugbank_id).toBe('DB00945');
        // MedDRA terms gone; FDA signal + count preserved.
        expect(c.fda_signals.faers_top_adr_terms).toBeUndefined();
        expect(c.fda_signals.faers_top_adr_terms_visibility.withheld_item_count).toBe(2);
        expect(c.fda_signals.has_boxed_warning).toBe(true);
        expect(c.fda_signals.boxed_warning_text).toBe('FDA MANDATED WARNING');
        expect(c.fda_signals.faers_total_top_count).toBe(15900);

        expect(withheld).toEqual({ meddra: 2, kegg: 2 });
        const families = (filtered as any).source_visibility.withheld.map((m: any) => m.source_family);
        expect(families).toEqual(expect.arrayContaining(['meddra', 'kegg']));
    });
});

describe('applySourceRightsFilter - xrefs (KEGG only)', () => {
    it('excludes external_ids.kegg_drug_id, keeps DrugBank / RxNorm / UNII', () => {
        const input = {
            resolved: true, canonical_id: 'sciweon::compound::CID:2244', matched_on: 'pubchem_cid',
            xrefs: {
                pubchem_cid: 2244, chembl_id: 'CHEMBL25', inchi_key: 'BSY...',
                external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945', kegg_drug_id: KEGG_ID, rxcui: '1191' },
            },
        };
        const { filtered, withheld } = applySourceRightsFilter(input);
        expect(JSON.stringify(filtered)).not.toContain(KEGG_ID);
        expect((filtered.xrefs.external_ids as any).kegg_drug_id).toBeUndefined();
        expect(filtered.xrefs.external_ids.unii).toBe('R16CO5Y76E');
        expect(filtered.xrefs.external_ids.drugbank_id).toBe('DB00945');
        expect(filtered.xrefs.external_ids.rxcui).toBe('1191');
        expect(withheld).toEqual({ meddra: 0, kegg: 1 });
    });
});

describe('applySourceRightsFilter - open-source compatibility + edges', () => {
    it('leaves a PubChem/FDA/ChEMBL-only compound structurally unchanged with no marker', () => {
        const open = {
            id: 'sciweon::compound::CID:1983',
            compound: {
                pubchem_cid: 1983, chembl_id: 'CHEMBL112', inchi_key: 'RZVAJINKPMORJF-UHFFFAOYSA-N',
                external_ids: { unii: '362O9ITL9D', drugbank_id: 'DB00316' },
                fda_signals: { has_boxed_warning: false, faers_total_top_count: 0 },
                drug_status: { withdrawn: false, black_box_warning: false, atc_codes: ['N02BE01'] },
                _tier: 'T1',
            },
        };
        const before = JSON.parse(JSON.stringify(open));
        const { filtered, withheld } = applySourceRightsFilter(open);
        expect(filtered).toEqual(before);
        expect((filtered as any).source_visibility).toBeUndefined();
        expect(withheld).toEqual({ meddra: 0, kegg: 0 });
    });

    it('neutralizes faers ids inside a target negative_evidence_ids array', () => {
        const input = {
            snapshot_date: '2026-05-16',
            target: {
                uniprot_accession: 'P33261', gene_symbol: 'CYP2C19',
                negative_evidence_ids: [
                    'sciweon::neg::faers::CID:2244::acute_kidney_injury',
                    'sciweon::neg::trial_failure::NCT04123456',
                ],
            },
        };
        const { filtered, withheld } = applySourceRightsFilter(input);
        expect(JSON.stringify(filtered)).not.toContain(MEDDRA_SLUG);
        expect(filtered.target.negative_evidence_ids[0]).toMatch(/::rwh_[0-9a-f]{8}$/);
        expect(filtered.target.negative_evidence_ids[1]).toBe('sciweon::neg::trial_failure::NCT04123456');
        expect(withheld.meddra).toBe(1);
    });

    it('is idempotent and passes through non-objects', () => {
        const once = applySourceRightsFilter(negResponse()).filtered;
        const twice = applySourceRightsFilter(once).filtered;
        expect(twice).toEqual(once);
        expect(applySourceRightsFilter(null).filtered).toBeNull();
        expect(applySourceRightsFilter('x' as unknown).filtered).toBe('x');
    });
});
