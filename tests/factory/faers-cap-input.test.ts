// @ts-nocheck
/**
 * P-8R1 F3 cap-input validation helper (lib/faers-cap-input.js) contract tests.
 *
 * resolveFaersMaxRecords resolves the factory-3-aggregate.yml dispatch input
 * `faers_max_records` into either the canonical positive-integer STRING to
 * export as FAERS_BACKFILL_MAX_RECORDS, or null (= do NOT set the env =
 * UNBOUNDED / normal), and THROWS fail-loud on any contract violation.
 */

import { describe, it, expect } from 'vitest';

import { resolveFaersMaxRecords } from '../../scripts/factory/lib/faers-cap-input.js';

const DISPATCH = 'workflow_dispatch';

describe('resolveFaersMaxRecords - unbounded (null = no cap)', () => {
    it('input absent -> null (no cap)', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true' })).toBeNull();
    });
    it('input undefined -> null', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: undefined })).toBeNull();
    });
    it('input null -> null', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: null })).toBeNull();
    });
    it('empty string -> null (NOT coerced to 0)', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: '' })).toBeNull();
    });
    it('whitespace-only -> null', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: '   ' })).toBeNull();
    });
});

describe('resolveFaersMaxRecords - AUTO workflow_run path never capped', () => {
    it('workflow_run + a value + backfill_only=true -> null', () => {
        expect(resolveFaersMaxRecords({ eventName: 'workflow_run', backfillOnly: 'true', faersMaxRecords: '8000' })).toBeNull();
    });
    it('workflow_run + a value + backfill_only=false -> null (never inherits a cap)', () => {
        expect(resolveFaersMaxRecords({ eventName: 'workflow_run', backfillOnly: 'false', faersMaxRecords: '8000' })).toBeNull();
    });
    it('no eventName (defensive) -> null', () => {
        expect(resolveFaersMaxRecords({ backfillOnly: 'true', faersMaxRecords: '8000' })).toBeNull();
    });
});

describe('resolveFaersMaxRecords - requires backfill_only=true', () => {
    it('backfill_only=false + faers_max_records=8000 -> THROWS', () => {
        expect(() => resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'false', faersMaxRecords: '8000' }))
            .toThrow(/requires backfill_only=true/);
    });
    it('backfill_only absent + value -> THROWS', () => {
        expect(() => resolveFaersMaxRecords({ eventName: DISPATCH, faersMaxRecords: '8000' }))
            .toThrow(/requires backfill_only=true/);
    });
});

describe('resolveFaersMaxRecords - valid positive integer', () => {
    it('8000 + backfill_only=true + workflow_dispatch -> "8000" (canonical string)', () => {
        const out = resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: '8000' });
        expect(out).toBe('8000');
        expect(typeof out).toBe('string');
    });
    it('1 (minimum) -> "1"', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: '1' })).toBe('1');
    });
    it('whitespace-padded " 8000 " -> trimmed-then-accept -> "8000"', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: ' 8000 ' })).toBe('8000');
    });
    it('leading zeros "08000" -> canonical "8000"', () => {
        expect(resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords: '08000' })).toBe('8000');
    });
});

describe('resolveFaersMaxRecords - rejects non-positive-integers (fail-loud)', () => {
    const reject = (faersMaxRecords) =>
        () => resolveFaersMaxRecords({ eventName: DISPATCH, backfillOnly: 'true', faersMaxRecords });

    it('0 -> throws', () => { expect(reject('0')).toThrow(); });
    it('-5 -> throws', () => { expect(reject('-5')).toThrow(); });
    it('8000.5 (decimal) -> throws', () => { expect(reject('8000.5')).toThrow(); });
    it("'abc' -> throws", () => { expect(reject('abc')).toThrow(); });
    it("'NaN' -> throws", () => { expect(reject('NaN')).toThrow(); });
    it("'+8000' -> throws", () => { expect(reject('+8000')).toThrow(); });
    it("'8e3' -> throws", () => { expect(reject('8e3')).toThrow(); });
    it("'0x1f4' (hex) -> throws", () => { expect(reject('0x1f4')).toThrow(); });
    it('non-string number 8000 -> throws (workflow passes strings)', () => {
        expect(reject(8000)).toThrow(/expected a string/);
    });
});
