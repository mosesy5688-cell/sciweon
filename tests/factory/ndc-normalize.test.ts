// @ts-nocheck
/**
 * NDC HIPAA 11-digit normalizer tests (PR-RXN-1 LOCK 2 enforcement).
 * Locks the byte-exact normalization contract that downstream cross-linker
 * hash-equality lookups depend on.
 */

import { describe, it, expect } from 'vitest';
import { normalizeNdcTo11Digit } from '../../scripts/factory/lib/ndc-normalize.js';

describe('PR-RXN-1: normalizeNdcTo11Digit', () => {
    it('4-4-2 variant pads labeler segment', () => {
        expect(normalizeNdcTo11Digit('0042-0220-01')).toBe('00042022001');
    });

    it('5-3-2 variant pads product segment', () => {
        expect(normalizeNdcTo11Digit('50242-040-62')).toBe('50242004062');
    });

    it('5-4-1 variant pads package segment (prepend 0 to 1-char package)', () => {
        // 5-4-1 -> 5-4-2 HIPAA: pad package code from 1 to 2 digits.
        // "12345-6789-0" -> "12345-6789-00" -> "12345678900".
        expect(normalizeNdcTo11Digit('12345-6789-0')).toBe('12345678900');
    });

    it('5-4-2 canonical passes through (no pad needed)', () => {
        expect(normalizeNdcTo11Digit('12345-6789-01')).toBe('12345678901');
    });

    it('already-11-digit pure-numeric passes through', () => {
        expect(normalizeNdcTo11Digit('00042022001')).toBe('00042022001');
    });

    it('REJECT: 10-digit abbreviated form (LOCK 2)', () => {
        expect(normalizeNdcTo11Digit('0042022001')).toBe(null);
    });

    it('REJECT: non-numeric characters', () => {
        expect(normalizeNdcTo11Digit('1234X-6789-01')).toBe(null);
    });

    it('REJECT: empty string', () => {
        expect(normalizeNdcTo11Digit('')).toBe(null);
    });

    it('REJECT: malformed segment count (2 parts instead of 3)', () => {
        expect(normalizeNdcTo11Digit('12345-67890')).toBe(null);
    });

    it('REJECT: non-string input', () => {
        expect(normalizeNdcTo11Digit(null)).toBe(null);
        expect(normalizeNdcTo11Digit(undefined)).toBe(null);
        expect(normalizeNdcTo11Digit(12345678901)).toBe(null);
    });

    it('REJECT: post-normalization length drift', () => {
        // Hypothetical malformed segments that sum to wrong length should reject.
        expect(normalizeNdcTo11Digit('123-456-78')).toBe(null);
    });
});
