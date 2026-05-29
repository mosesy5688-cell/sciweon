// @ts-nocheck
/**
 * PR-RXN-1e diagnostic probe column-safety + classifier tests.
 *
 * Locks the UNII shape regex + classifier output shape so future RRF
 * column reorder (recurrence of Cont leadoff RXNSAT ATN/SAB/ATV drift)
 * cannot silently desync the diagnostic verdict.
 */

import { describe, it, expect } from 'vitest';
import { classifyMthsplCode } from '../../scripts/factory/diagnostic-rxnorm-mthspl.js';

describe('PR-RXN-1e: classifyMthsplCode UNII shape oracle', () => {
    it('1. canonical NLM UNII shape (10-char uppercase alnum) matches', () => {
        const r = classifyMthsplCode('8MJB9HSC8Q');
        expect(r.unii_shape).toBe(true);
        expect(r.length).toBe(10);
    });

    it('2. lowercase 10-char alnum does NOT match (NLM convention is uppercase)', () => {
        const r = classifyMthsplCode('8mjb9hsc8q');
        expect(r.unii_shape).toBe(false);
        expect(r.length).toBe(10);
    });

    it('3. wrong length (9 / 11 / 12) does NOT match', () => {
        expect(classifyMthsplCode('8MJB9HSC8').unii_shape).toBe(false);   // 9
        expect(classifyMthsplCode('8MJB9HSC8QQ').unii_shape).toBe(false); // 11
        expect(classifyMthsplCode('8MJB9HSC8QQQ').unii_shape).toBe(false); // 12
    });

    it('4. mixed alphanumeric uppercase still passes (UNII may include digits in any position)', () => {
        expect(classifyMthsplCode('AAAAAAAAAA').unii_shape).toBe(true);    // all letters
        expect(classifyMthsplCode('0000000000').unii_shape).toBe(true);    // all digits
        expect(classifyMthsplCode('A1B2C3D4E5').unii_shape).toBe(true);    // interleaved
    });

    it('5. special chars / whitespace / null / undefined / non-string -> shape miss, no throw', () => {
        expect(classifyMthsplCode('8MJB9HSC8-').unii_shape).toBe(false);   // hyphen
        expect(classifyMthsplCode('8MJB9 HSC8').unii_shape).toBe(false);   // space
        expect(classifyMthsplCode(' 8MJB9HSC8Q ').unii_shape).toBe(false); // padded -- diagnostic intentionally strict
        expect(classifyMthsplCode('').unii_shape).toBe(false);
        expect(classifyMthsplCode(null).unii_shape).toBe(false);
        expect(classifyMthsplCode(undefined).unii_shape).toBe(false);
        expect(classifyMthsplCode(8123456789).unii_shape).toBe(false);     // numeric
    });

    it('6. classifier output shape is stable: { unii_shape, length }', () => {
        const r = classifyMthsplCode('8MJB9HSC8Q');
        expect(Object.keys(r).sort()).toEqual(['length', 'unii_shape']);
        expect(typeof r.unii_shape).toBe('boolean');
        expect(typeof r.length).toBe('number');
    });
});
