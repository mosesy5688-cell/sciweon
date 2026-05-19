/**
 * Tests for V0.5.7 V2-adapter pagination control.
 *
 * Anchored in 6-Wave plan Wave H2b-1 fix: each V2 adapter previously
 * issued a single pageSize=200 call and silently dropped records beyond.
 * shouldFetchNextPage decides the loop body; nextSinceTokenAfterLoop
 * decides whether the cursor advances to today or holds for next cron.
 *
 * Both are pure functions. Provider-specific URL / response parsing
 * stays in each adapter and is integration-tested via cron.
 */

import { describe, it, expect } from 'vitest';
import {
    shouldFetchNextPage,
    nextSinceTokenAfterLoop,
    DEFAULT_MAX_RECORDS,
    DEFAULT_MAX_PAGES,
} from '../../scripts/factory/lib/pagination-control.js';

describe('shouldFetchNextPage', () => {
    it('hasMoreSignal=false → stop_exhausted (provider says no more pages)', () => {
        const d = shouldFetchNextPage({ recordsFetched: 100, pagesDone: 1, hasMoreSignal: false });
        expect(d.kind).toBe('stop_exhausted');
    });

    it('recordsFetched >= maxRecords → stop_record_cap with cap', () => {
        const d = shouldFetchNextPage({
            recordsFetched: 5000,
            pagesDone: 10,
            hasMoreSignal: true,
            maxRecords: 5000,
        });
        expect(d.kind).toBe('stop_record_cap');
        expect(d.cap).toBe(5000);
    });

    it('pagesDone >= maxPages → stop_page_cap with cap', () => {
        const d = shouldFetchNextPage({
            recordsFetched: 100,
            pagesDone: 50,
            hasMoreSignal: true,
            maxPages: 50,
        });
        expect(d.kind).toBe('stop_page_cap');
        expect(d.cap).toBe(50);
    });

    it('healthy mid-loop state → continue', () => {
        const d = shouldFetchNextPage({
            recordsFetched: 400,
            pagesDone: 2,
            hasMoreSignal: true,
        });
        expect(d.kind).toBe('continue');
    });

    it('record cap takes precedence over page cap when both fire', () => {
        const d = shouldFetchNextPage({
            recordsFetched: 9999,
            pagesDone: 999,
            hasMoreSignal: true,
            maxRecords: 5000,
            maxPages: 50,
        });
        expect(d.kind).toBe('stop_record_cap');
    });

    it('custom maxRecords / maxPages override defaults', () => {
        // With default DEFAULT_MAX_RECORDS=5000 this would still continue;
        // a tight cap of 100 should immediately stop_record_cap.
        const d = shouldFetchNextPage({
            recordsFetched: 200,
            pagesDone: 2,
            hasMoreSignal: true,
            maxRecords: 100,
        });
        expect(d.kind).toBe('stop_record_cap');
        expect(d.cap).toBe(100);
    });

    it('defaults exported match DEFAULT_MAX_RECORDS=5000, DEFAULT_MAX_PAGES=50', () => {
        expect(DEFAULT_MAX_RECORDS).toBe(5000);
        expect(DEFAULT_MAX_PAGES).toBe(50);
    });
});

describe('nextSinceTokenAfterLoop', () => {
    it('stop_exhausted → advance to today', () => {
        const r = nextSinceTokenAfterLoop({
            stopKind: 'stop_exhausted',
            sinceToken: '2026-05-15',
            today: '2026-05-19',
        });
        expect(r).toBe('2026-05-19');
    });

    it('stop_record_cap → hold at sinceToken (idempotent retry)', () => {
        const r = nextSinceTokenAfterLoop({
            stopKind: 'stop_record_cap',
            sinceToken: '2026-05-15',
            today: '2026-05-19',
        });
        expect(r).toBe('2026-05-15');
    });

    it('stop_page_cap → hold at sinceToken (idempotent retry)', () => {
        const r = nextSinceTokenAfterLoop({
            stopKind: 'stop_page_cap',
            sinceToken: '2026-05-15',
            today: '2026-05-19',
        });
        expect(r).toBe('2026-05-15');
    });
});
