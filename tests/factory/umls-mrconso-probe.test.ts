// @ts-nocheck
/**
 * PR-UMLS-0: pure helpers for the UMLS MRCONSO diagnostic probe.
 * Locks candidate-URL discovery (newest-first, both filename variants) + the per-SAB
 * tally at the TENTATIVE DOC_SAB_INDEX (the value is doc-assumed-pending-verification --
 * these tests assert the tally MECHANISM, not that index 11 is the real SAB column).
 */

import { describe, it, expect } from 'vitest';
import {
    candidateMetathesaurusUrls, newSabTally, addSabTally, DOC_SAB_INDEX, TARGET_SABS,
} from '../../scripts/factory/lib/umls-mrconso-probe.js';

describe('candidateMetathesaurusUrls', () => {
    it('newest-first across years x {AB,AA} x 2 filename variants, all kss/<rel> paths', () => {
        const urls = candidateMetathesaurusUrls(new Date(Date.UTC(2026, 5, 1)));
        // 3 years (2026,2025,2024) x 2 (AB,AA) x 2 variants = 12
        expect(urls).toHaveLength(12);
        expect(urls[0]).toBe('https://download.nlm.nih.gov/umls/kss/2026AB/umls-2026AB-metathesaurus-full.zip');
        expect(urls[1]).toBe('https://download.nlm.nih.gov/umls/kss/2026AB/umls-2026AB-metathesaurus.zip');
        expect(urls.every(u => u.startsWith('https://download.nlm.nih.gov/umls/kss/'))).toBe(true);
        // newest-first: 2026AB before 2026AA before 2025AB
        expect(urls.findIndex(u => u.includes('2026AB'))).toBeLessThan(urls.findIndex(u => u.includes('2026AA')));
        expect(urls.findIndex(u => u.includes('2026AA'))).toBeLessThan(urls.findIndex(u => u.includes('2025AB')));
    });
});

describe('addSabTally (tentative DOC_SAB_INDEX)', () => {
    const row = (sab) => { const f = new Array(18).fill(''); f[DOC_SAB_INDEX] = sab; return f; };

    it('tallies the 3 target SABs at DOC_SAB_INDEX; everything else -> other', () => {
        const t = newSabTally();
        addSabTally(t, row('MSH'));
        addSabTally(t, row('SNOMEDCT_US'));
        addSabTally(t, row('LNC'));
        addSabTally(t, row('RXNORM'));   // non-target
        addSabTally(t, row('MSH'));
        expect(t).toEqual({ MSH: 2, SNOMEDCT_US: 1, LNC: 1, other: 1 });
    });

    it('non-array / short row -> other, never throws', () => {
        const t = newSabTally();
        addSabTally(t, null);
        addSabTally(t, ['CUI', 'ENG']);  // too short to reach index 11
        expect(t.other).toBe(2);
    });

    it('DOC_SAB_INDEX is 11 (documented) and TARGET_SABS are the 3 vocab SABs', () => {
        expect(DOC_SAB_INDEX).toBe(11);
        expect(TARGET_SABS).toEqual(['MSH', 'SNOMEDCT_US', 'LNC']);
    });
});
