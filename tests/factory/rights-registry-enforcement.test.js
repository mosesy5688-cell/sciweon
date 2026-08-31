// @ts-nocheck
/**
 * F0-RIGHTS-REGISTRY regression guard.
 *
 * The pre-existing containment is a DENYLIST applied at serialization: it
 * removes shapes it recognises, so an unrecognised source, a renamed field or
 * a reshaped payload passes straight through. It fails OPEN.
 *
 * These tests lock the inversion, AND the four corrections the Founder's
 * review required:
 *   1. a self-declared tuple is never publishable;
 *   2. the capture manifest is actually checked, including source match and
 *      pointer correspondence;
 *   3. planes come back physically distinct, never one flat array;
 *   4. obligations are labelled DECLARED, not enforced, and the module
 *      reports that it is not end-to-end.
 *
 * The 25 fields are frozen. A failure here because the list changed is the
 * test doing its job -- the list may only change by founder ruling.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveRights, assessRights, verifyAgainstManifest, partitionIntoPlanes,
    ADJUDICATED_FIELDS, PLANES, NOT_IN_APPROVED_PLANE, TOTAL_ADJUDICATED_FIELDS,
    ENFORCEMENT_STATUS,
    PLANE_CLEAN_COMMERCIAL, PLANE_LICENSED_SHAREALIKE, PLANE_BIBLIOGRAPHIC,
    STATE_UNRESOLVED, STATE_NOT_IN_APPROVED_PLANE,
    STATE_REQUIRES_VERIFICATION, STATE_VERIFIED,
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
        expect(r.rights_state).not.toBe('CLEAN_COMMERCIAL_ATTRIBUTION');
    });

    it('no source can reach a plane that is not its own', () => {
        for (const [src, plane] of [['pubchem', PLANE_CLEAN_COMMERCIAL],
            ['chembl', PLANE_LICENSED_SHAREALIKE], ['pubmed', PLANE_BIBLIOGRAPHIC]]) {
            for (const f of ADJUDICATED_FIELDS[src]) {
                expect(resolveRights(src, f).plane).toBe(plane);
            }
        }
    });
});

describe('CORRECTION 1 -- a self-declared tuple is NOT publishable', () => {
    it('an adjudicated tuple with two plausible strings and NO manifest is refused', () => {
        // The previous defect: any caller could self-certify by asserting a
        // permitted source/field plus two non-empty strings.
        const a = assessRights(unit('pubchem', 'inchi_key'));
        expect(a.rights.adjudicated).toBe(true);
        expect(a.publishable).toBe(false);
        expect(a.terminal_state).toBe(STATE_REQUIRES_VERIFICATION);
        expect(a.verification.reason).toBe('no_manifest_supplied');
    });

    it('becomes publishable only once an independent manifest confirms it', () => {
        const a = assessRights(unit('pubchem', 'inchi_key'),
            manifestFor('pubchem', 'inchi_key'));
        expect(a.publishable).toBe(true);
        expect(a.terminal_state).toBe(STATE_VERIFIED);
    });
});

describe('CORRECTION 2 -- the manifest is actually checked', () => {
    it('a capture_ref absent from the manifest is refused', () => {
        const u = { ...unit('pubchem', 'inchi_key'), capture_ref: 'capture:made-up' };
        expect(assessRights(u, manifestFor('pubchem', 'inchi_key')).verification.reason)
            .toBe('capture_ref_not_in_manifest');
    });

    it('a declared source that disagrees with the capture is refused', () => {
        // Claiming a PubChem field while pointing at a ChEMBL capture.
        const u = { source: 'pubchem', field: 'inchi_key',
            capture_ref: 'capture:chembl:1', source_pointer: '$.inchi_key' };
        const m = [{ capture_ref: 'capture:chembl:1', source: 'chembl',
            source_pointers: ['$.inchi_key'] }];
        const v = assessRights(u, m).verification;
        expect(v.verified).toBe(false);
        expect(v.reason).toBe('declared_source_does_not_match_capture');
        expect(v.declared_source).toBe('pubchem');
        expect(v.capture_source).toBe('chembl');
    });

    it('a pointer not recorded against that capture is refused', () => {
        const u = { ...unit('pubmed', 'pmid'), source_pointer: '$.somewhere_else' };
        expect(assessRights(u, manifestFor('pubmed', 'pmid')).verification.reason)
            .toBe('pointer_not_recorded_for_capture');
    });

    it('a manifest entry with no source or no pointers cannot verify anything', () => {
        const noSrc = [{ capture_ref: 'capture:pubmed:1', source_pointers: ['$.pmid'] }];
        expect(verifyAgainstManifest(unit('pubmed', 'pmid'), noSrc).reason)
            .toBe('manifest_entry_has_no_source');
        const noPtr = [{ capture_ref: 'capture:pubmed:1', source: 'pubmed' }];
        expect(verifyAgainstManifest(unit('pubmed', 'pmid'), noPtr).reason)
            .toBe('manifest_entry_records_no_pointers');
    });

    it('missing capture_ref or source_pointer is refused before any lookup', () => {
        expect(verifyAgainstManifest({ source: 'pubmed', source_pointer: '$.pmid' }, [])
            .reason).toBe('missing_capture_ref');
        expect(verifyAgainstManifest({ source: 'pubmed', capture_ref: 'c' }, [])
            .reason).toBe('missing_source_pointer');
    });
});
