// @ts-nocheck
/**
 * Tests for fda-srs-probe.js -- Phase 1.8 PR-FDA-SRS-1 Rail 7 + Rail 8.
 *
 * Focus: pure-function unit coverage. Network + ZIP I/O is mocked out;
 * the probe's main() is exercised end-to-end by the GHA workflow itself.
 */

import { describe, it, expect } from 'vitest';
import {
    computeSortedHeaderChecksum, parseLastModifiedToDate,
} from '../../scripts/factory/fda-srs-probe.js';

describe('computeSortedHeaderChecksum -- Rail 7 stability', () => {
    it('returns stable sha256-prefixed hex for known header', () => {
        const result = computeSortedHeaderChecksum('UNII\tPT\tRN\tInChIKey');
        expect(result).toMatch(/^sha256-[0-9a-f]{64}$/);
    });

    it('produces IDENTICAL checksum regardless of column order (sorted-header invariance)', () => {
        const a = computeSortedHeaderChecksum('UNII\tPT\tRN\tInChIKey');
        const b = computeSortedHeaderChecksum('InChIKey\tRN\tPT\tUNII');
        const c = computeSortedHeaderChecksum('PT\tInChIKey\tUNII\tRN');
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('produces DIFFERENT checksum when a column is added (Rail 7 trip condition)', () => {
        const before = computeSortedHeaderChecksum('UNII\tPT\tRN\tInChIKey');
        const after = computeSortedHeaderChecksum('UNII\tPT\tRN\tInChIKey\tSynonyms');
        expect(before).not.toBe(after);
    });

    it('produces DIFFERENT checksum when a column is renamed (Rail 7 trip condition)', () => {
        const before = computeSortedHeaderChecksum('UNII\tPT\tRN\tInChIKey');
        const after = computeSortedHeaderChecksum('UNII\tPT\tRN\tinchikey');  // lowercase rename
        expect(before).not.toBe(after);
    });

    it('produces DIFFERENT checksum when a column is removed', () => {
        const before = computeSortedHeaderChecksum('UNII\tPT\tRN\tInChIKey');
        const after = computeSortedHeaderChecksum('UNII\tPT\tInChIKey');
        expect(before).not.toBe(after);
    });

    it('throws on empty header', () => {
        expect(() => computeSortedHeaderChecksum('')).toThrow();
    });

    it('throws on whitespace-only header', () => {
        expect(() => computeSortedHeaderChecksum('   \t   ')).toThrow();
    });

    it('throws on non-string input', () => {
        expect(() => computeSortedHeaderChecksum(null)).toThrow();
        expect(() => computeSortedHeaderChecksum(undefined)).toThrow();
        expect(() => computeSortedHeaderChecksum(42)).toThrow();
    });

    it('trims column-name whitespace before sorting (resilient to trailing space)', () => {
        const a = computeSortedHeaderChecksum('UNII\tPT\tRN\tInChIKey');
        const b = computeSortedHeaderChecksum('UNII \tPT\t RN\tInChIKey');
        expect(a).toBe(b);
    });
});

describe('parseLastModifiedToDate', () => {
    it('parses standard HTTP Last-Modified header to YYYY-MM-DD', () => {
        expect(parseLastModifiedToDate('Thu, 26 Feb 2026 14:32:11 GMT')).toBe('2026-02-26');
    });

    it('returns null on null / empty input', () => {
        expect(parseLastModifiedToDate(null)).toBeNull();
        expect(parseLastModifiedToDate('')).toBeNull();
        expect(parseLastModifiedToDate(undefined)).toBeNull();
    });

    it('returns null on malformed date string', () => {
        expect(parseLastModifiedToDate('not a date')).toBeNull();
        expect(parseLastModifiedToDate('xyz')).toBeNull();
    });
});
