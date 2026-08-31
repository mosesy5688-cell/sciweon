// @ts-nocheck
/**
 * F0-RIGHTS-ENFORCEMENT regression guard.
 *
 * The pre-existing containment is a DENYLIST applied at serialization: it
 * removes shapes it recognises, so an unrecognised source, a renamed field or
 * a reshaped payload passes straight through. It fails OPEN. That is
 * survivable for a hosted surface that can be patched and not survivable for
 * an artifact shipped to a customer machine.
 *
 * These tests lock the inversion: nothing is publishable unless Gate-5B
 * adjudicated it, and every refusal is reported rather than swallowed.
 *
 * The 25 fields are frozen. If a test here fails because the list changed,
 * that is the test doing its job -- the list may only change by founder ruling.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveRights, attachRights, filterPublishable,
    ADJUDICATED_FIELDS, PLANES, WITHHELD_SOURCES, TOTAL_ADJUDICATED_FIELDS,
    PLANE_CLEAN_COMMERCIAL, PLANE_LICENSED_SHAREALIKE, PLANE_BIBLIOGRAPHIC,
    STATE_UNRESOLVED, STATE_WITHHELD,
} from '../../scripts/factory/lib/rights-registry.js';

const traceable = (source, field) => ({
    source, field, value: 'x',
    capture_ref: 'capture:example@raw_sha:deadbeef',
    source_pointer: '$.example.path',
});

describe('the frozen Gate-5B set is exactly 25 fields in three planes', () => {
    it('counts reconcile with the Decision Log', () => {
        expect(ADJUDICATED_FIELDS.pubchem.size).toBe(5);
        expect(ADJUDICATED_FIELDS.chembl.size).toBe(14);
        expect(ADJUDICATED_FIELDS.pubmed.size).toBe(6);
        expect(TOTAL_ADJUDICATED_FIELDS).toBe(25);
    });

    it('PubChem carries only the FIELD-QUALIFIED state, never an unconditional grant', () => {
        const r = resolveRights('pubchem', 'inchi_key');
        expect(r.plane).toBe(PLANE_CLEAN_COMMERCIAL);
        expect(r.rights_state).toBe('CLEAN_COMMERCIAL_FIELD_QUALIFIED');
        // Gate-5B refuses an unconditional grant with POSITIVE_GRANT_NOT_SUPPORTED.
        expect(r.rights_state).not.toBe('CLEAN_COMMERCIAL_ATTRIBUTION');
        expect(r.obligations).toContain('no_unconditional_commercial_grant');
    });

    it('ChEMBL routes only into the share-alike plane, with its obligations', () => {
        const r = resolveRights('chembl', 'standard_value');
        expect(r.plane).toBe(PLANE_LICENSED_SHAREALIKE);
        expect(r.licence).toBe('CC BY-SA 3.0 Unported');
        expect(r.attribution).toBe('ChEMBL, EMBL-EBI');
        expect(r.obligations).toEqual(
            expect.arrayContaining(['attribution', 'share_alike', 'physically_separate_plane']));
    });

    it('PubMed routes only into the bibliographic plane, with the NLM obligations', () => {
        const r = resolveRights('pubmed', 'pmid');
        expect(r.plane).toBe(PLANE_BIBLIOGRAPHIC);
        expect(r.rights_state).toBe('NO_LICENCE_GRANTED_ATTRIBUTION_REQUIRED');
        expect(r.attribution).toContain('National Library of Medicine');
        expect(r.obligations).toContain('currency_disclosure_on_republication');
    });

    it('no source can reach a plane that is not its own', () => {
        for (const [src, plane] of [['pubchem', PLANE_CLEAN_COMMERCIAL],
            ['chembl', PLANE_LICENSED_SHAREALIKE], ['pubmed', PLANE_BIBLIOGRAPHIC]]) {
            for (const f of ADJUDICATED_FIELDS[src]) {
                expect(resolveRights(src, f).plane).toBe(plane);
            }
        }
    });

    it('every adjudicated field is publishable when traceable', () => {
        for (const src of Object.keys(ADJUDICATED_FIELDS)) {
            for (const f of ADJUDICATED_FIELDS[src]) {
                expect(attachRights(traceable(src, f)).publishable).toBe(true);
            }
        }
    });
});

describe('FAIL CLOSED: anything not adjudicated is refused', () => {
    it('an unknown source is UNRESOLVED, not assumed open', () => {
        for (const src of ['openfda', 'clinicaltrials', 'rxnorm', 'openalex',
            'pubchem-bioassay', 'semanticscholar', 'retraction-watch']) {
            const r = resolveRights(src, 'some_field');
            expect(r.publishable).toBe(false);
            expect(r.rights_state).toBe(STATE_UNRESOLVED);
            expect(r.reason).toBe('source_not_adjudicated');
        }
    });

    it('an UNADJUDICATED FIELD of an adjudicated source is still refused', () => {
        // The trap: pubchem is adjudicated, so a careless implementation would
        // wave through any pubchem field. Only the five are permitted.
        for (const f of ['xlogp', 'molecular_weight', 'canonical_smiles', 'tpsa']) {
            const r = resolveRights('pubchem', f);
            expect(r.publishable).toBe(false);
            expect(r.reason).toBe('field_not_adjudicated');
        }
    });

    it('withheld sources are refused on every field', () => {
        for (const src of WITHHELD_SOURCES) {
            for (const f of ['accession', 'chembl_id', 'meddra_pt', 'anything']) {
                const r = resolveRights(src, f);
                expect(r.publishable).toBe(false);
                expect(r.rights_state).toBe(STATE_WITHHELD);
            }
        }
    });

    it('UniProt and UniChem stay withheld even for fields named like adjudicated ones', () => {
        // The demo dossier in the governance tree labels UniProt
        // ATTRIBUTION_REQUIRED and sources chembl_id from UniChem. Gate-5B
        // ruled both WITHHELD. The registry must not reproduce that error.
        expect(resolveRights('uniprot', 'accession').publishable).toBe(false);
        expect(resolveRights('unichem', 'chembl_id').publishable).toBe(false);
        expect(resolveRights('uniprot', 'protein_name').rights_state).toBe(STATE_WITHHELD);
    });

    it('malformed or hostile shapes resolve to UNRESOLVED and never throw', () => {
        for (const [s, f] of [[null, null], [undefined, 'pmid'], ['pubmed', undefined],
            [{}, []], [123, 456], ['', ''], ['  ', 'pmid']]) {
            const r = resolveRights(s, f);
            expect(r.publishable).toBe(false);
            expect(r.rights_state).toBe(STATE_UNRESOLVED);
        }
        expect(attachRights(null).publishable).toBe(false);
        expect(attachRights('not-an-object').publishable).toBe(false);
    });

    it('case and whitespace cannot be used to smuggle a field through', () => {
        expect(resolveRights('  PubChem ', ' InChI_Key ').publishable).toBe(true);
        expect(resolveRights('PUBCHEM', 'XLOGP').publishable).toBe(false);
    });
});

describe('traceability is required, not optional', () => {
    it('an adjudicated field without capture_ref or source_pointer is NOT publishable', () => {
        const noCapture = { source: 'pubmed', field: 'doi', value: '10.1/x',
            source_pointer: '$.a' };
        const noPointer = { source: 'pubmed', field: 'doi', value: '10.1/x',
            capture_ref: 'capture:x@raw_sha:1' };
        for (const u of [noCapture, noPointer]) {
            const a = attachRights(u);
            expect(a.rights.publishable).toBe(true);      // the RIGHT is fine
            expect(a.publishable).toBe(false);            // publication is not
            expect(a.publish_block_reason).toBe('missing_capture_ref_or_source_pointer');
        }
    });
});

describe('rights travel with the unit, and refusals are reported', () => {
    it('attachRights writes the envelope into the unit at build time', () => {
        const u = attachRights(traceable('chembl', 'pchembl_value'));
        expect(u.rights.plane).toBe(PLANE_LICENSED_SHAREALIKE);
        expect(u.rights.attribution).toBe('ChEMBL, EMBL-EBI');
        expect(u.traceable).toBe(true);
        // Survives serialization -- it is a property of the record, not of a filter.
        expect(JSON.parse(JSON.stringify(u)).rights.licence).toBe('CC BY-SA 3.0 Unported');
    });

    it('filterPublishable itemises every refusal instead of dropping silently', () => {
        const { publishable, refused, refused_count } = filterPublishable([
            traceable('pubchem', 'inchi_key'),
            traceable('pubchem', 'xlogp'),
            traceable('uniprot', 'accession'),
            traceable('openfda', 'report_count'),
            { source: 'pubmed', field: 'pmid', value: 1 },
        ]);
        expect(publishable).toHaveLength(1);
        expect(refused_count).toBe(4);
        expect(refused.map(r => r.reason).sort()).toEqual([
            'field_not_adjudicated',
            'missing_capture_ref_or_source_pointer',
            'source_not_adjudicated',
            'source_withheld_by_ruling',
        ]);
    });

    it('an empty or non-array input publishes nothing rather than everything', () => {
        for (const bad of [null, undefined, {}, 'x', 0]) {
            expect(filterPublishable(bad).publishable).toHaveLength(0);
        }
    });

    it('the plane table is frozen against accidental mutation', () => {
        expect(Object.isFrozen(PLANES)).toBe(true);
        expect(Object.isFrozen(ADJUDICATED_FIELDS.pubchem)).toBe(true);
        // Object.freeze(new Set()) does NOT seal a Set's contents -- the
        // allowlist therefore exposes no mutator at all.
        expect(ADJUDICATED_FIELDS.pubchem.add).toBeUndefined();
        expect(ADJUDICATED_FIELDS.pubchem.delete).toBeUndefined();
        expect(WITHHELD_SOURCES.add).toBeUndefined();
        expect(ADJUDICATED_FIELDS.pubchem.has('xlogp')).toBe(false);
    });
});
