// @ts-nocheck
/**
 * F0-RIGHTS-REGISTRY regression guard, part 2 of 2.
 *
 * Split from `rights-registry-enforcement.test.js to stay under the 250-line
 * code cap. Coverage was split, not reduced.
 *
 * Part 1 covers the frozen 25-field set, self-declaration refusal and manifest
 * verification. This part covers plane separation, the declared-not-enforced
 * labelling, and the fail-closed behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveRights, assessRights, partitionIntoPlanes,
    ADJUDICATED_FIELDS, PLANES, NOT_IN_APPROVED_PLANE, ENFORCEMENT_STATUS,
    PLANE_CLEAN_COMMERCIAL, PLANE_LICENSED_SHAREALIKE, PLANE_BIBLIOGRAPHIC,
    STATE_UNRESOLVED, STATE_NOT_IN_APPROVED_PLANE,
} from '../../scripts/factory/lib/rights-registry.js';

const unit = (source, field) => ({
    source, field, value: 'x',
    capture_ref: `capture:${source}:1`,
    source_pointer: `$.${field}`,
});

const manifestFor = (source, field) => ([{
    capture_ref: `capture:${source}:1`,
    source,
    source_pointers: [`$.${field}`],
}]);

describe('CORRECTION 3 -- planes come back physically distinct', () => {
    it('partitions into three separate collections, never one flat array', () => {
        const units = [unit('pubchem', 'inchi_key'), unit('chembl', 'standard_value'),
            unit('pubmed', 'pmid'), unit('pubchem', 'xlogp'), unit('uniprot', 'accession')];
        const manifest = [
            ...manifestFor('pubchem', 'inchi_key'),
            { capture_ref: 'capture:chembl:1', source: 'chembl', source_pointers: ['$.standard_value'] },
            { capture_ref: 'capture:pubmed:1', source: 'pubmed', source_pointers: ['$.pmid'] },
        ];
        const out = partitionIntoPlanes(units, manifest);
        expect(Array.isArray(out)).toBe(false);
        expect(out[PLANE_CLEAN_COMMERCIAL]).toHaveLength(1);
        expect(out[PLANE_LICENSED_SHAREALIKE]).toHaveLength(1);
        expect(out[PLANE_BIBLIOGRAPHIC]).toHaveLength(1);
        expect(out.refused_count).toBe(2);
        // The share-alike plane must not be commingled with the clean plane.
        expect(out[PLANE_CLEAN_COMMERCIAL].every(u => u.rights.source === 'pubchem')).toBe(true);
        expect(out[PLANE_LICENSED_SHAREALIKE].every(u => u.rights.source === 'chembl')).toBe(true);
    });

    it('refusals are itemised with a reason, never dropped silently', () => {
        const out = partitionIntoPlanes([
            unit('pubchem', 'xlogp'), unit('uniprot', 'accession'),
            unit('openfda', 'report_count'), unit('pubchem', 'inchi_key'),
        ], []);
        // An EMPTY manifest is still a manifest, so an adjudicated tuple fails
        // on lookup rather than on absence -- the two are distinguished.
        expect(out.refused.map(r => r.reason).sort()).toEqual([
            'capture_ref_not_in_manifest', 'field_not_adjudicated',
            'no_field_in_any_approved_plane', 'source_not_adjudicated',
        ]);
        // No manifest at all is reported differently from an empty one.
        expect(partitionIntoPlanes([unit('pubchem', 'inchi_key')], undefined)
            .refused[0].reason).toBe('no_manifest_supplied');
    });

    it('a non-array input yields empty planes rather than everything', () => {
        for (const bad of [null, undefined, {}, 'x', 0]) {
            const out = partitionIntoPlanes(bad, []);
            expect(out[PLANE_CLEAN_COMMERCIAL]).toHaveLength(0);
            expect(out[PLANE_LICENSED_SHAREALIKE]).toHaveLength(0);
            expect(out[PLANE_BIBLIOGRAPHIC]).toHaveLength(0);
        }
    });
});

describe('CORRECTION 4 -- obligations are DECLARED, not enforced', () => {
    it('every obligation is explicitly marked unenforced', () => {
        for (const plane of Object.values(PLANES)) {
            for (const o of plane.obligations) {
                expect(o.enforced).toBe(false);
                expect(typeof o.obligation).toBe('string');
            }
        }
    });

    it('share-alike and attribution are reported but not executed', () => {
        const sa = PLANES[PLANE_LICENSED_SHAREALIKE].obligations.map(o => o.obligation);
        expect(sa).toEqual(expect.arrayContaining(['attribution', 'share_alike']));
        expect(PLANES[PLANE_LICENSED_SHAREALIKE].obligations.every(o => !o.enforced)).toBe(true);
    });

    it('the module declares itself NOT end-to-end', () => {
        expect(ENFORCEMENT_STATUS.end_to_end).toBe(false);
        expect(ENFORCEMENT_STATUS.wired_into_serving_path).toBe(false);
        expect(ENFORCEMENT_STATUS.wired_into_packaging_path).toBe(false);
        expect(assessRights(unit('pubmed', 'doi')).enforcement.end_to_end).toBe(false);
        expect(partitionIntoPlanes([], []).enforcement.end_to_end).toBe(false);
    });
});

describe('FAIL CLOSED: anything not adjudicated is refused', () => {
    it('an unknown source is UNRESOLVED, not assumed open', () => {
        for (const src of ['openfda', 'clinicaltrials', 'rxnorm', 'openalex',
            'pubchem-bioassay', 'semanticscholar', 'retraction-watch']) {
            const r = resolveRights(src, 'some_field');
            expect(r.adjudicated).toBe(false);
            expect(r.rights_state).toBe(STATE_UNRESOLVED);
            expect(r.reason).toBe('source_not_adjudicated');
        }
    });

    it('an UNADJUDICATED FIELD of an adjudicated source is still refused', () => {
        for (const f of ['xlogp', 'molecular_weight', 'canonical_smiles', 'tpsa']) {
            expect(resolveRights('pubchem', f).reason).toBe('field_not_adjudicated');
        }
    });

    it('UniProt and UniChem have no field in any approved plane', () => {
        // The demo dossier in the governance tree labels UniProt
        // ATTRIBUTION_REQUIRED and sources chembl_id from UniChem. Gate-5B
        // placed neither in a plane. The registry must not repeat that.
        for (const src of NOT_IN_APPROVED_PLANE) {
            for (const f of ['accession', 'chembl_id', 'meddra_pt', 'anything']) {
                expect(resolveRights(src, f).rights_state).toBe(STATE_NOT_IN_APPROVED_PLANE);
            }
        }
    });

    it('malformed or hostile shapes resolve to UNRESOLVED and never throw', () => {
        for (const [s, f] of [[null, null], [undefined, 'pmid'], ['pubmed', undefined],
            [{}, []], [123, 456], ['', ''], ['  ', 'pmid']]) {
            expect(resolveRights(s, f).adjudicated).toBe(false);
        }
        expect(assessRights(null).publishable).toBe(false);
        expect(assessRights('not-an-object').publishable).toBe(false);
    });

    it('case and whitespace cannot smuggle a field through', () => {
        expect(resolveRights('  PubChem ', ' InChI_Key ').adjudicated).toBe(true);
        expect(resolveRights('PUBCHEM', 'XLOGP').adjudicated).toBe(false);
    });

    it('the allowlist exposes no mutator at all', () => {
        // Object.freeze(new Set()) does NOT seal a Set's contents.
        expect(ADJUDICATED_FIELDS.pubchem.add).toBeUndefined();
        expect(ADJUDICATED_FIELDS.pubchem.delete).toBeUndefined();
        expect(NOT_IN_APPROVED_PLANE.add).toBeUndefined();
        expect(ADJUDICATED_FIELDS.pubchem.has('xlogp')).toBe(false);
    });
});
