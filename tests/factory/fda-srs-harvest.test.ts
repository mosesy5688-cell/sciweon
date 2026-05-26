// @ts-nocheck
/**
 * Tests for fda-srs-harvest.js -- Phase 1.8 PR-FDA-SRS-1 Rail 5.
 *
 * Focus: shared normalizeInChIKey invariant + edge cases that defend
 * silent lookup miss. Full streaming pipeline tested end-to-end by GHA
 * workflow itself.
 */

import { describe, it, expect } from 'vitest';
import { normalizeInChIKey } from '../../scripts/factory/fda-srs-harvest.js';

describe('normalizeInChIKey -- Rail 5 invariant', () => {
    it('accepts canonical InChIKey unchanged', () => {
        expect(normalizeInChIKey('RDHQFKQIGNGIED-UHFFFAOYSA-N')).toBe('RDHQFKQIGNGIED-UHFFFAOYSA-N');
    });

    it('trims leading/trailing whitespace (defends FDA SRS dirty export)', () => {
        expect(normalizeInChIKey('  RDHQFKQIGNGIED-UHFFFAOYSA-N  ')).toBe('RDHQFKQIGNGIED-UHFFFAOYSA-N');
        expect(normalizeInChIKey('\tRDHQFKQIGNGIED-UHFFFAOYSA-N\n')).toBe('RDHQFKQIGNGIED-UHFFFAOYSA-N');
    });

    it('uppercases a real 14-10-1 lowercase key correctly', () => {
        // 14 + dash + 10 + dash + 1 = 27 chars
        const lower = 'abcdefghijklmn-opqrstuvwx-y';
        expect(lower.length).toBe(27);
        expect(normalizeInChIKey(lower)).toBe('ABCDEFGHIJKLMN-OPQRSTUVWX-Y');
    });

    it('uppercases mixed-case canonical InChIKey correctly', () => {
        // Real-world InChIKey: 3 F's in UHFFFAOYSA (10-char middle block)
        expect(normalizeInChIKey('rdhqfkqigngied-uhfffaoysa-n')).toBe('RDHQFKQIGNGIED-UHFFFAOYSA-N');
        expect(normalizeInChIKey('RdHqFkQiGnGiEd-UhFfFaOyA-n'.replace('UhFfFaOyA-n', 'UhFfFaOySA-n'))).toBe('RDHQFKQIGNGIED-UHFFFAOYSA-N');
    });

    it('rejects wrong-length strings', () => {
        expect(normalizeInChIKey('SHORT-A-B')).toBeNull();
        expect(normalizeInChIKey('TOOLONG-XXXXX-XXXXXXXX-XXXXXX')).toBeNull();
        expect(normalizeInChIKey('')).toBeNull();
        expect(normalizeInChIKey('   ')).toBeNull();
    });

    it('rejects malformed 27-char strings (not matching 14-10-1 pattern)', () => {
        expect(normalizeInChIKey('AAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();  // no dashes
        expect(normalizeInChIKey('AAAAAAAAAAAAA-AAAAAAAAA-AAA')).toBeNull();  // 13-9-3 not 14-10-1
        expect(normalizeInChIKey('AAAAAAAAAAAAAAA-AAAAAAAAA-A')).toBeNull();  // 15-9-1 not 14-10-1
    });

    it('rejects non-string input', () => {
        expect(normalizeInChIKey(null)).toBeNull();
        expect(normalizeInChIKey(undefined)).toBeNull();
        expect(normalizeInChIKey(42)).toBeNull();
        expect(normalizeInChIKey({})).toBeNull();
    });

    it('rejects strings with non-alphanumeric chars (defends format-violation injection)', () => {
        expect(normalizeInChIKey('RDHQFKQIGNGI@D-UHFFFAOYSA-N')).toBeNull();
        expect(normalizeInChIKey('RDHQFKQIGNGIED-UHFF AOYSA-N')).toBeNull();
    });
});
