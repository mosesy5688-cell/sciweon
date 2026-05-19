/**
 * Tests for V0.5.7 ChEMBL sinceToken year parser.
 *
 * Anchored in 6-Wave plan H2b-2 fix: chembl V2 adapter previously sent
 * molecule_date__gte=YYYY-MM-DD which ChEMBL rejects with HTTP 400. The
 * new adapter uses first_approval / withdrawn_year (year-granularity)
 * filters, so the cursor is a YYYY string. Legacy YYYY-MM-DD cursors
 * must degrade gracefully (read leading YYYY).
 */

import { describe, it, expect } from 'vitest';
import {
    parseSinceYear,
    bootstrapSinceYear,
    resolveSinceYear,
} from '../../scripts/factory/lib/chembl-since-token.js';

describe('parseSinceYear', () => {
    it('YYYY token returns the year integer', () => {
        expect(parseSinceYear('2024')).toBe(2024);
        expect(parseSinceYear('2026')).toBe(2026);
    });

    it('legacy YYYY-MM-DD token returns leading year (V0.5.6 cursor compat)', () => {
        expect(parseSinceYear('2024-05-19')).toBe(2024);
        expect(parseSinceYear('2026-01-01')).toBe(2026);
    });

    it('null / undefined / empty returns null', () => {
        expect(parseSinceYear(null)).toBeNull();
        expect(parseSinceYear(undefined)).toBeNull();
        expect(parseSinceYear('')).toBeNull();
    });

    it('non-year string returns null', () => {
        expect(parseSinceYear('notayear')).toBeNull();
        expect(parseSinceYear('foo-bar')).toBeNull();
        // ChEMBL release IDs (small integers like "34") shouldn't be misread as years
        expect(parseSinceYear('34')).toBeNull();
    });

    it('out-of-range year returns null', () => {
        expect(parseSinceYear('1899')).toBeNull();
        expect(parseSinceYear('3000')).toBeNull();
    });
});

describe('resolveSinceYear', () => {
    it('valid token wins', () => {
        expect(resolveSinceYear('2024')).toBe(2024);
        expect(resolveSinceYear('2024-05-19')).toBe(2024);
    });

    it('garbage input falls back to bootstrapSinceYear (currentYear - 1)', () => {
        const bootstrap = bootstrapSinceYear();
        expect(resolveSinceYear('garbage')).toBe(bootstrap);
        expect(resolveSinceYear(null)).toBe(bootstrap);
        expect(resolveSinceYear('')).toBe(bootstrap);
    });

    it('bootstrapSinceYear is currentYear - 1', () => {
        const thisYear = new Date().getUTCFullYear();
        expect(bootstrapSinceYear()).toBe(thisYear - 1);
    });
});
