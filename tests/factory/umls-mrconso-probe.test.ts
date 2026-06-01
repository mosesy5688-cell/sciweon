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
    classifyArchiveHead, ZIP_MAGIC, MIN_RELEASE_BYTES,
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

describe('classifyArchiveHead (PR-UMLS-0a archive-validity guard)', () => {
    const pkHead = (extra = 8) => Buffer.concat([ZIP_MAGIC, Buffer.alloc(extra, 0xff)]);

    it('locks the threshold + ZIP magic constants', () => {
        expect(MIN_RELEASE_BYTES).toBe(100_000_000);
        expect([...ZIP_MAGIC]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });

    it('(a) PK magic + Content-Length >= 100MB -> looks_real true', () => {
        const c = classifyArchiveHead(pkHead(), '4000000000');
        expect(c.is_zip).toBe(true);
        expect(c.size_ok).toBe(true);
        expect(c.looks_real).toBe(true);
        expect(c.magic_hex).toBe('504b0304');
    });

    it('(b) 196-byte non-PK body (proxy false-200) -> is_zip false, looks_real false', () => {
        const stub = Buffer.from('<html>not found redirect stub</html>'.padEnd(196, ' '));
        const c = classifyArchiveHead(stub, '196');
        expect(c.is_zip).toBe(false);
        expect(c.looks_real).toBe(false);
        expect(c.magic_hex).not.toBe('504b0304');
    });

    it('(c) PK magic + small Content-Length -> size_ok false, looks_real false', () => {
        const c = classifyArchiveHead(pkHead(), '196');
        expect(c.is_zip).toBe(true);
        expect(c.size_ok).toBe(false);
        expect(c.looks_real).toBe(false);
    });

    it('(d) PK magic + ABSENT Content-Length -> magic-alone fallback, looks_real true', () => {
        expect(classifyArchiveHead(pkHead(), undefined).looks_real).toBe(true);
        expect(classifyArchiveHead(pkHead(), null).looks_real).toBe(true);
        expect(classifyArchiveHead(pkHead(), '').looks_real).toBe(true);
        // non-numeric Content-Length also falls back to magic-alone (size_ok true)
        expect(classifyArchiveHead(pkHead(), 'chunked').looks_real).toBe(true);
    });

    it('(e) buffer < 4 bytes / non-buffer -> is_zip false, never throws', () => {
        expect(classifyArchiveHead(Buffer.from([0x50, 0x4b]), '4000000000').is_zip).toBe(false);
        expect(classifyArchiveHead(Buffer.alloc(0), undefined).is_zip).toBe(false);
        // @ts-expect-error intentionally non-buffer input
        expect(classifyArchiveHead(null, '4000000000')).toMatchObject({ is_zip: false, looks_real: false });
        // @ts-expect-error intentionally non-buffer input
        expect(classifyArchiveHead('PK', '4000000000').is_zip).toBe(false);
    });
});
