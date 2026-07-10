/**
 * RC-3A (D-132G) unit tests for the shared source-rights containment filter,
 * corrected per founder audit: DELETE restricted MedDRA id/url/term fields
 * (never tokenize), REMOVE FAERS-MedDRA-derived id-list entries entirely, and
 * emit NO deterministic surrogate (rwh_/FNV/digest) of any protected value.
 */

import { describe, it, expect } from 'vitest';
import { applySourceRightsFilter } from '../../src/worker/lib/source-rights-filter';

const MEDDRA_PT = 'ACUTE KIDNEY INJURY';
const MEDDRA_SLUG = 'acute_kidney_injury';
const KEGG_ID = 'D00109';
const WITHHELD = 'withheld_by_rights_policy';
const FAERS_ID = 'sciweon::neg::faers::CID:2244::acute_kidney_injury';

// Replicates the REJECTED FNV-1a surrogate so the negative control can prove it
// is absent from the corrected output.
function oldFnvSurrogate(id: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return `rwh_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function faersSignal() {
    return {
        id: FAERS_ID,
        url: `https://sciweon.com/api/v1/entity/${encodeURIComponent(FAERS_ID)}`,
        evidence_type: 'faers_adr_signal', severity: 'critical', reason_category: 'meddra_pt_adr',
        confidence: 85, subject: { compound_id: 'sciweon::compound::CID:2244' },
        failure: { reason_category: 'meddra_pt_adr', reason_text: MEDDRA_PT },
        detail: { meddra_pt: MEDDRA_PT, report_count: 15000, unii: 'R16CO5Y76E' },
        provenance: { primary_source: 'openfda_faers', source_id: 'R16CO5Y76E' },
    };
}
function negResponse() {
    return {
        compound: { id: 'sciweon::compound::CID:2244' }, snapshot_date: '2026-05-16',
        negative_signals_count: 2, signals_by_severity: { critical: 1, major: 0, minor: 0, unknown: 1 },
        signals: [
            faersSignal(),
            {
                id: 'sciweon::neg::trial_failure::NCT04123456', evidence_type: 'trial_failure', severity: 'unknown',
                subject: { compound_id: 'sciweon::compound::CID:2244' }, detail: {},
                provenance: { primary_source: 'clinicaltrials_gov' },
            },
        ],
    };
}

describe('MedDRA faers signal - delete, never tokenize', () => {
    it('deletes meddra_pt/reason_text/id/url + markers; preserves the signal', () => {
        const { filtered, withheld } = applySourceRightsFilter(negResponse());
        const json = JSON.stringify(filtered);
        expect(json).not.toContain(MEDDRA_PT);
        expect(json).not.toContain(MEDDRA_SLUG);
        expect(json).not.toContain('rwh_');

        const s = filtered.signals[0] as any;
        expect(s.id).toBeUndefined();
        expect(s.url).toBeUndefined();
        expect(s.detail.meddra_pt).toBeUndefined();
        expect(s.failure.reason_text).toBeUndefined();
        // explicit site markers.
        expect(s.id_visibility).toEqual({ source_visibility_state: WITHHELD, source_family: 'meddra' });
        expect(s.url_visibility).toEqual({ source_visibility_state: WITHHELD, source_family: 'meddra' });
        expect(s.detail.meddra_pt_visibility).toBe(WITHHELD);
        expect(s.failure.reason_text_visibility).toBe(WITHHELD);
        // signal still represented (withheld != absent).
        expect(s.evidence_type).toBe('faers_adr_signal');
        expect(s.severity).toBe('critical');
        expect(s.detail.report_count).toBe(15000);
        expect(s.provenance.primary_source).toBe('openfda_faers');
        expect(s.reason_category).toBe('meddra_pt_adr'); // founder KEEP
        // non-MedDRA signal untouched.
        expect((filtered.signals[1] as any).id).toBe('sciweon::neg::trial_failure::NCT04123456');
        expect((filtered.signals[1] as any).id_visibility).toBeUndefined();

        expect(filtered.negative_signals_count).toBe(2);
        expect(withheld).toEqual({ meddra: 1, kegg: 0 });
        expect((filtered as any).source_visibility.withheld).toContainEqual(
            { source_visibility_state: WITHHELD, source_family: 'meddra', withheld_item_count: 1 },
        );
    });

    it('NEGATIVE CONTROL: emits no FNV/rwh deterministic surrogate of the id', () => {
        const surrogate = oldFnvSurrogate(FAERS_ID);
        expect(surrogate).toMatch(/^rwh_[0-9a-f]{8}$/); // the OLD design would have emitted this
        const json = JSON.stringify(applySourceRightsFilter(negResponse()).filtered);
        expect(json).not.toContain(surrogate);
        expect(json).not.toContain('rwh_');
    });

    it('does not mutate the input object (clone-safe)', () => {
        const input = negResponse();
        applySourceRightsFilter(input);
        expect((input.signals[0].detail as any).meddra_pt).toBe(MEDDRA_PT);
        expect(input.signals[0].id).toBe(FAERS_ID);
        expect((input as any).source_visibility).toBeUndefined();
    });
});

describe('compound record - MedDRA faers_top_adr_terms + KEGG', () => {
    function compound() {
        return {
            id: 'sciweon::compound::CID:2244',
            compound: {
                pubchem_cid: 2244, chembl_id: 'CHEMBL25',
                external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945', kegg_drug_id: KEGG_ID, rxcui: '1191' },
                kegg_drug: { d_number: KEGG_ID, diseases: [{ indication: 'x', kegg_disease_id: 'H00001' }] },
                fda_signals: {
                    has_boxed_warning: true, boxed_warning_text: 'FDA MANDATED WARNING',
                    faers_top_adr_terms: [{ term: MEDDRA_PT, count: 15000 }, { term: 'HEPATIC FAILURE', count: 900 }],
                    faers_total_top_count: 15900,
                },
            },
        };
    }
    it('withholds kegg_drug, kegg_drug_id, faers_top_adr_terms; keeps FDA + xrefs', () => {
        const { filtered, withheld } = applySourceRightsFilter(compound());
        const json = JSON.stringify(filtered);
        expect(json).not.toContain(MEDDRA_PT);
        expect(json).not.toContain('HEPATIC FAILURE');
        expect(json).not.toContain(KEGG_ID);
        expect(json).not.toContain('H00001');
        const c = filtered.compound as any;
        expect(c.kegg_drug).toBeUndefined();
        expect(c.external_ids.kegg_drug_id).toBeUndefined();
        expect(c.external_ids.unii).toBe('R16CO5Y76E');
        expect(c.external_ids.drugbank_id).toBe('DB00945');
        expect(c.fda_signals.faers_top_adr_terms).toBeUndefined();
        expect(c.fda_signals.faers_top_adr_terms_visibility.withheld_item_count).toBe(2);
        expect(c.fda_signals.has_boxed_warning).toBe(true);
        expect(c.fda_signals.boxed_warning_text).toBe('FDA MANDATED WARNING');
        expect(c.fda_signals.faers_total_top_count).toBe(15900);
        expect(withheld).toEqual({ meddra: 2, kegg: 2 });
    });
});

describe('xrefs - KEGG output containment', () => {
    it('excludes external_ids.kegg_drug_id, keeps DrugBank / RxNorm / UNII', () => {
        const input = {
            resolved: true, canonical_id: 'sciweon::compound::CID:2244', matched_on: 'pubchem_cid',
            xrefs: { pubchem_cid: 2244, external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945', kegg_drug_id: KEGG_ID, rxcui: '1191' } },
        };
        const { filtered, withheld } = applySourceRightsFilter(input);
        expect(JSON.stringify(filtered)).not.toContain(KEGG_ID);
        expect((filtered.xrefs.external_ids as any).kegg_drug_id).toBeUndefined();
        expect(filtered.xrefs.external_ids.drugbank_id).toBe('DB00945');
        expect(filtered.xrefs.external_ids.rxcui).toBe('1191');
        expect(withheld).toEqual({ meddra: 0, kegg: 1 });
    });
});

describe('FAERS-MedDRA id-lists - remove entries entirely', () => {
    it('removes faers ids from target.negative_evidence_ids; keeps aggregate count', () => {
        const input = {
            target: {
                gene_symbol: 'CYP2C19', counts: { negative_evidence: 2 },
                negative_evidence_ids: [FAERS_ID, 'sciweon::neg::trial_failure::NCT04123456'],
            },
        };
        const { filtered, withheld } = applySourceRightsFilter(input);
        expect(JSON.stringify(filtered)).not.toContain(MEDDRA_SLUG);
        expect(filtered.target.negative_evidence_ids).toEqual(['sciweon::neg::trial_failure::NCT04123456']);
        expect((filtered.target as any).negative_evidence_ids_visibility.withheld_item_count).toBe(1);
        expect(filtered.target.counts.negative_evidence).toBe(2); // aggregate preserved -> withheld != absent
        expect(withheld.meddra).toBe(1);
    });

    it('removes thin faers examples from a repurposing negative summary', () => {
        const input = {
            summary: {
                negative: {
                    signals_count: 3, signals_by_severity: { critical: 1, major: 0, minor: 0, unknown: 2 },
                    examples: [
                        { id: FAERS_ID, evidence_type: 'faers_adr_signal', severity: 'critical' },
                        { id: 'sciweon::neg::trial_failure::NCT04123456', evidence_type: 'trial_failure', severity: 'unknown' },
                    ],
                },
            },
        };
        const { filtered, withheld } = applySourceRightsFilter(input);
        expect(JSON.stringify(filtered)).not.toContain(MEDDRA_SLUG);
        const neg = filtered.summary.negative as any;
        expect(neg.examples).toHaveLength(1);
        expect(neg.examples[0].evidence_type).toBe('trial_failure');
        expect(neg.examples_visibility.withheld_item_count).toBe(1);
        expect(neg.signals_count).toBe(3); // aggregate preserved
        expect(withheld.meddra).toBe(1);
    });
});

describe('compatibility, idempotency, passthrough', () => {
    it('leaves a PubChem/FDA/ChEMBL-only compound unchanged with no marker', () => {
        const open = {
            id: 'sciweon::compound::CID:1983',
            compound: {
                pubchem_cid: 1983, chembl_id: 'CHEMBL112',
                external_ids: { unii: '362O9ITL9D', drugbank_id: 'DB00316' },
                fda_signals: { has_boxed_warning: false, faers_total_top_count: 0 },
                drug_status: { withdrawn: false, atc_codes: ['N02BE01'] },
            },
        };
        const before = JSON.parse(JSON.stringify(open));
        const { filtered, withheld } = applySourceRightsFilter(open);
        expect(filtered).toEqual(before);
        expect((filtered as any).source_visibility).toBeUndefined();
        expect(withheld).toEqual({ meddra: 0, kegg: 0 });
    });

    it('is idempotent and passes non-objects through', () => {
        const once = applySourceRightsFilter(negResponse()).filtered;
        const twice = applySourceRightsFilter(once).filtered;
        expect(twice).toEqual(once);
        expect(applySourceRightsFilter(null).filtered).toBeNull();
        expect(applySourceRightsFilter('x' as unknown).filtered).toBe('x');
    });
});
