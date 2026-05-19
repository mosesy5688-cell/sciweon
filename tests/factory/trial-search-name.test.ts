/**
 * Tests for V0.5.6 trial-linker intervention-name selector.
 *
 * Anchored in 6-Wave plan H2a-4 high-leverage fix: previous getSearchName
 * sent IUPAC strings to ClinicalTrials.gov's intervention search (query.intr),
 * yielding ~0 trials per compound. CT.gov expects consumer-facing drug
 * names (aspirin, imatinib), so the new priority puts external_ids.rxnorm_name
 * first, then a filtered "best synonym", then IUPAC as last resort.
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

    it('falls back to IUPAC when synonyms are all systematic-coded', () => {
        const c = {
            external_ids: {},
            synonyms: ['50-78-2', 'CHEBI:15365'],
            iupac_name: '2-acetoxybenzoic acid',
            pubchem_cid: 2244,
        };
        expect(pickTrialSearchName(c)).toEqual({
            name: '2-acetoxybenzoic acid',
            source: 'iupac_fallback',
        });
    });

    it('falls back to CID when nothing usable', () => {
        const c = {
            external_ids: {},
            synonyms: ['50-78-2'],
            pubchem_cid: 999,
        };
        const pick = pickTrialSearchName(c);
        expect(pick).toEqual({ name: 'CID:999', source: 'cid_fallback' });
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
