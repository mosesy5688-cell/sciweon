/**
 * Tests for V0.5.6 trial-linker intervention-name selector.
 *
 * Anchored in 6-Wave plan H2a-4 high-leverage fix: previous getSearchName
 * sent IUPAC strings to ClinicalTrials.gov's intervention search (query.intr),
 * yielding ~0 trials per compound. CT.gov expects consumer-facing drug
 * names (aspirin, imatinib), so the new priority puts external_ids.rxnorm_name
 * first, then a filtered "best synonym".
 *
 * THE HTTP 400 FLOOD FIX: a raw IUPAC string is not merely zero-hit -- CT.gov's
 * Essie `query.intr` parser treats `[ ] ( ) , ;` as OPERATORS, so a bracketed
 * IUPAC is a MALFORMED query that DETERMINISTICALLY returns HTTP 400. A `CID:<n>`
 * placeholder is a valid HTTP 200 query but guaranteed zero-hit (a wasted request).
 * NEITHER is a CT.gov-searchable name, so both were DROPPED in favour of a terminal
 * sentinel {name:null, source:'no_searchable_name'} (the linker records the
 * negative + skips CT.gov, never 400-flooding, never counting it as a transient
 * fetch failure).
 *
 * Both exports are pure functions. trial-linker.js integration tests
 * happen via factory-3-aggregate workflow_dispatch end-to-end.
 */

import { describe, it, expect } from 'vitest';
import {
    pickBestSynonym,
    pickTrialSearchName,
} from '../../scripts/factory/lib/trial-search-name.js';

describe('pickBestSynonym', () => {
    it('returns null on null / undefined / empty array', () => {
        expect(pickBestSynonym(null)).toBeNull();
        expect(pickBestSynonym(undefined)).toBeNull();
        expect(pickBestSynonym([])).toBeNull();
    });

    it('returns null when all synonyms are systematic codes (CAS / CHEBI only)', () => {
        const synonyms = ['50-78-2', 'CHEBI:15365', 'KEGG:D00109', 'NSC-27223'];
        expect(pickBestSynonym(synonyms)).toBeNull();
    });

    it('prefers shortest valid candidate ("aspirin" over "acetylsalicylic acid")', () => {
        const synonyms = ['acetylsalicylic acid', 'aspirin', 'ASA'];
        // ASA is 3 letters but len < s.length * 0.5 check: 3 letters / 3 chars = 1.0, passes.
        // Shortest among all three = "ASA"
        const pick = pickBestSynonym(synonyms);
        expect(pick).toBe('ASA');
    });

    it('falls back to mid-length when shortest is rejected as systematic', () => {
        const synonyms = ['acetylsalicylic acid', 'aspirin', '50-78-2'];
        expect(pickBestSynonym(synonyms)).toBe('aspirin');
    });

    it('rejects CAS number from candidate set', () => {
        const synonyms = ['50-78-2', 'aspirin'];
        expect(pickBestSynonym(synonyms)).toBe('aspirin');
    });

    it('rejects CHEBI / KEGG prefixed codes', () => {
        const synonyms = ['CHEBI:15365', 'KEGG:D00109', 'aspirin'];
        expect(pickBestSynonym(synonyms)).toBe('aspirin');
    });

    it('rejects synonym > 80 chars (IUPAC-ish) but accepts short plausible names', () => {
        const longIupac = '2-(acetyloxy)benzoic acid; 2-acetoxybenzoic acid; acetic acid salicylic acid ester';
        const synonyms = [longIupac, 'aspirin'];
        expect(pickBestSynonym(synonyms)).toBe('aspirin');
    });
});

describe('pickTrialSearchName', () => {
    it('rxnorm_name wins when present (even if synonyms also present)', () => {
        const c = {
            external_ids: { rxnorm_name: 'aspirin' },
            synonyms: ['acetylsalicylic acid', 'ASA'],
            iupac_name: '2-acetoxybenzoic acid',
            pubchem_cid: 2244,
        };
        expect(pickTrialSearchName(c)).toEqual({ name: 'aspirin', source: 'rxnorm_name' });
    });

    it('falls back to best synonym when rxnorm_name missing', () => {
        const c = {
            external_ids: {},
            synonyms: ['acetylsalicylic acid', 'aspirin'],
            iupac_name: '2-acetoxybenzoic acid',
            pubchem_cid: 2244,
        };
        const pick = pickTrialSearchName(c);
        expect(pick.source).toBe('synonym');
        expect(pick.name).toBe('aspirin');
    });

    it('IUPAC-only (no rxnorm/synonym) -> no_searchable_name terminal (was iupac_fallback; CT.gov 400s on a bracketed IUPAC)', () => {
        const c = {
            external_ids: {},
            synonyms: ['50-78-2', 'CHEBI:15365'],
            // a real bracketed IUPAC -- CT.gov Essie query.intr returns HTTP 400 on this.
            iupac_name: '(1S)-4,17-dimethyl-17-azatetracyclo[7.5.3.01,10.02,7]heptadeca-2(7),3,5-triene',
            pubchem_cid: 441074,
        };
        expect(pickTrialSearchName(c)).toEqual({ name: null, source: 'no_searchable_name' });
    });

    it('short IUPAC-only is ALSO no_searchable_name (the < 200-char gate never made a bracketed IUPAC safe)', () => {
        const c = {
            external_ids: {},
            synonyms: ['50-78-2', 'CHEBI:15365'],
            iupac_name: '2-acetoxybenzoic acid',
            pubchem_cid: 2244,
        };
        expect(pickTrialSearchName(c)).toEqual({ name: null, source: 'no_searchable_name' });
    });

    it('CID-only (no rxnorm/synonym/IUPAC) -> no_searchable_name (a `CID:<n>` query.intr is a guaranteed zero-hit waste, dropped)', () => {
        const c = {
            external_ids: {},
            synonyms: ['50-78-2'],
            pubchem_cid: 999,
        };
        expect(pickTrialSearchName(c)).toEqual({ name: null, source: 'no_searchable_name' });
    });

    it('no usable field at all -> no_searchable_name', () => {
        const c = { external_ids: {}, synonyms: [] };
        expect(pickTrialSearchName(c)).toEqual({ name: null, source: 'no_searchable_name' });
    });

    it('real-world: aspirin with mixed-quality fields returns rxnorm_name', () => {
        const aspirin = {
            external_ids: { rxnorm_name: 'aspirin' },
            synonyms: ['50-78-2', 'acetylsalicylic acid', 'ASA'],
            iupac_name: '2-acetoxybenzoic acid',
            pubchem_cid: 2244,
        };
        expect(pickTrialSearchName(aspirin)).toEqual({
            name: 'aspirin',
            source: 'rxnorm_name',
        });
    });
});
