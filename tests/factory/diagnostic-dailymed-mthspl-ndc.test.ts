// @ts-nocheck
/**
 * PR-MD-1a-probe: classifyNdcFormat tests.
 *
 * Locks the SSoT-delegation contract: the classifier assigns a human-readable
 * shape bucket but NEVER re-implements normalizeNdcTo11Digit's rules -- a
 * 3-segment string the SSoT rejects (e.g. 5-4-3) must report normalizable=false
 * even though its shape is hyphenated-3seg. canonical === normalizeNdcTo11Digit.
 */

import { describe, it, expect } from 'vitest';
import { classifyNdcFormat } from '../../scripts/factory/diagnostic-dailymed-mthspl-ndc.js';
import { normalizeNdcTo11Digit } from '../../scripts/factory/lib/ndc-normalize.js';

describe('classifyNdcFormat', () => {
    it('hyphenated 3-seg HIPAA (5-4-2) -> hyphenated-3seg, normalizable, SSoT canonical', () => {
        const r = classifyNdcFormat('70771-1953-1');  // 5-4-1 -> pad pkg
        expect(r.shape).toBe('hyphenated-3seg');
        expect(r.normalizable).toBe(true);
        expect(r.canonical).toBe('70771195301');
        expect(r.canonical).toBe(normalizeNdcTo11Digit('70771-1953-1'));
    });

    it('hyphenless 11-digit -> hyphenless-11, normalizable, pass-through', () => {
        const r = classifyNdcFormat('70771195301');
        expect(r.shape).toBe('hyphenless-11');
        expect(r.normalizable).toBe(true);
        expect(r.canonical).toBe('70771195301');
    });

    it('hyphenless 10-digit -> hyphenless-10, NOT normalizable (ambiguous)', () => {
        const r = classifyNdcFormat('7077119530');
        expect(r.shape).toBe('hyphenless-10');
        expect(r.normalizable).toBe(false);
        expect(r.canonical).toBe(null);
    });

    it('hyphenless 12-digit -> hyphenless-12, NOT normalizable', () => {
        const r = classifyNdcFormat('707711953012');
        expect(r.shape).toBe('hyphenless-12');
        expect(r.normalizable).toBe(false);
    });

    it('SSoT-DELEGATION GUARD: 3-segment but non-HIPAA width (5-4-3) -> shape hyphenated-3seg but normalizable=false', () => {
        const r = classifyNdcFormat('12345-6789-012');
        expect(r.shape).toBe('hyphenated-3seg');
        expect(r.normalizable).toBe(false);  // SSoT rejects; classifier must NOT override
        expect(r.canonical).toBe(null);
        expect(r.canonical).toBe(normalizeNdcTo11Digit('12345-6789-012'));
    });

    it('empty / null / non-string -> invalid, not normalizable, no throw', () => {
        expect(classifyNdcFormat('')).toEqual({ shape: 'invalid', normalizable: false, canonical: null });
        expect(classifyNdcFormat(null)).toEqual({ shape: 'invalid', normalizable: false, canonical: null });
        expect(classifyNdcFormat(12345)).toEqual({ shape: 'invalid', normalizable: false, canonical: null });
    });
});
