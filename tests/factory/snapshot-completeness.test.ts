/**
 * Tests for cycle 22 PR-L4 — snapshot-bridge helpers (completeness +
 * backfill shared logic).
 *
 * Per [[feedback_no_shortcut_in_science]] triple-lock scale-in-time leg:
 * Layer 4 daily snapshot completeness measurement is mandatory. These
 * tests lock the completeness logic to prevent silent regressions in
 * the detection mechanism itself.
 */

import { describe, it, expect } from 'vitest';
import {
    expectedDateRange, computeCompleteness,
} from '../../scripts/factory/lib/snapshot-bridge.js';

describe('expectedDateRange', () => {
    it('window 0 returns just today', () => {
        const r = expectedDateRange(0, '2026-05-23');
        expect(r).toEqual(['2026-05-23']);
    });

    it('window 3 returns 4 dates (today + 3 prior)', () => {
        const r = expectedDateRange(3, '2026-05-23');
        expect(r).toEqual(['2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23']);
    });

    it('window 7 returns 8 dates sorted asc', () => {
        const r = expectedDateRange(7, '2026-05-23');
        expect(r.length).toBe(8);
        expect(r[0]).toBe('2026-05-16');
        expect(r[r.length - 1]).toBe('2026-05-23');
        // Sorted ascending check
        for (let i = 1; i < r.length; i++) {
            expect(r[i] > r[i - 1]).toBe(true);
        }
    });

    it('handles month boundary correctly', () => {
        const r = expectedDateRange(3, '2026-06-02');
        expect(r).toEqual(['2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02']);
    });

    it('handles year boundary correctly', () => {
        const r = expectedDateRange(2, '2026-01-01');
        expect(r).toEqual(['2025-12-30', '2025-12-31', '2026-01-01']);
    });

    it('handles leap day correctly (2024 leap year)', () => {
        const r = expectedDateRange(3, '2024-03-01');
        expect(r).toEqual(['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01']);
    });

    it('throws on invalid today format', () => {
        expect(() => expectedDateRange(7, '2026/05/23')).toThrow();
        expect(() => expectedDateRange(7, 'today')).toThrow();
    });
});

describe('computeCompleteness', () => {
    it('all present → 100% present_pct, empty missing', () => {
        const expected = ['2026-05-21', '2026-05-22', '2026-05-23'];
        const present = ['2026-05-21', '2026-05-22', '2026-05-23'];
        const r = computeCompleteness(expected, present);
        expect(r.present).toEqual(['2026-05-21', '2026-05-22', '2026-05-23']);
        expect(r.missing).toEqual([]);
        expect(r.present_pct).toBe(100);
    });

    it('partial present → correct % + missing list', () => {
        const expected = ['2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24'];
        const present = ['2026-05-21', '2026-05-23'];
        const r = computeCompleteness(expected, present);
        expect(r.present).toEqual(['2026-05-21', '2026-05-23']);
        expect(r.missing).toEqual(['2026-05-22', '2026-05-24']);
        expect(r.present_pct).toBe(50);
    });

    it('production observed: 5/14 + 5/19 missing in 9-day window', () => {
        const expected = [
            '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17',
            '2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22',
        ];
        const present = [
            '2026-05-15', '2026-05-16', '2026-05-17', '2026-05-18',
            '2026-05-20', '2026-05-21', '2026-05-22',
        ];
        const r = computeCompleteness(expected, present);
        expect(r.missing).toEqual(['2026-05-14', '2026-05-19']);
        expect(r.present_pct).toBe(77.78);
    });

    it('present has dates outside expected window → ignored (no inflation)', () => {
        const expected = ['2026-05-22', '2026-05-23'];
        const present = ['2026-01-01', '2026-05-22', '2026-05-23', '2026-12-31'];
        const r = computeCompleteness(expected, present);
        expect(r.present).toEqual(['2026-05-22', '2026-05-23']);
        expect(r.missing).toEqual([]);
        expect(r.present_pct).toBe(100);
    });

    it('empty expected → 100% by definition (no expectations to miss)', () => {
        const r = computeCompleteness([], ['2026-05-23']);
        expect(r.present_pct).toBe(100);
        expect(r.missing).toEqual([]);
    });

    it('zero present → 0% + all missing', () => {
        const expected = ['2026-05-22', '2026-05-23'];
        const r = computeCompleteness(expected, []);
        expect(r.present_pct).toBe(0);
        expect(r.missing).toEqual(['2026-05-22', '2026-05-23']);
    });
});
