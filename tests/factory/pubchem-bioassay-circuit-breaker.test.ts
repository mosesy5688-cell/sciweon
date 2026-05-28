// @ts-nocheck
/**
 * PR-CORE-PUBCHEM-BIOASSAY-DRAIN 2026-05-28 — 503-storm circuit breaker.
 *
 * Triggered by F2 run 26567469567 stuck 2.5h: PubChem PUG REST 503 storm;
 * per-CID 3-retry exponential backoff (~3-15s each) cascaded across
 * thousands of CIDs into multi-hour F2 black-hole. Without circuit
 * breaker, drainAdapterBacklog never reached chunk-boundary budget check.
 *
 * Test contract: after CIRCUIT_503_THRESHOLD (=3) consecutive
 * fetchAssaySummaryByCid throw 503, all subsequent calls short-circuit
 * to [] WITHOUT issuing any HTTP request (verified via fetch-helper
 * call-count). Module-level state persists across calls but is reset
 * by resetCircuitBreaker() (test isolation hook).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the underlying fetch-with-retry helper used by the adapter.
// The adapter calls fetchJsonWithRetry(url, opts) — we control its
// behavior to deterministically simulate 503 exhaustion / success.
vi.mock('../../scripts/factory/lib/fetch-with-retry.js', () => {
    return {
        fetchJsonWithRetry: vi.fn(),
    };
});

import { fetchJsonWithRetry } from '../../scripts/factory/lib/fetch-with-retry.js';
import {
    fetchAssaySummaryByCid,
    getCircuitBreakerState,
    resetCircuitBreaker,
} from '../../scripts/ingestion/adapters/pubchem-bioassay-adapter.js';

describe('PR-CORE-PUBCHEM-BIOASSAY-DRAIN: 503-storm circuit breaker', () => {
    beforeEach(() => {
        resetCircuitBreaker();
        vi.mocked(fetchJsonWithRetry).mockReset();
    });

    it('1. cold start: breaker not tripped, counter at 0', () => {
        const s = getCircuitBreakerState();
        expect(s.tripped).toBe(false);
        expect(s.consecutive503).toBe(0);
    });

    it('2. 3 consecutive 503 exhaustions trip breaker; 4th call issues NO HTTP', async () => {
        vi.mocked(fetchJsonWithRetry).mockRejectedValue(
            new Error('HTTP 503: https://pubchem.example/cid/x (attempt 3/3)')
        );

        const r1 = await fetchAssaySummaryByCid(101);
        const r2 = await fetchAssaySummaryByCid(102);
        const r3 = await fetchAssaySummaryByCid(103);
        expect(r1).toEqual([]);
        expect(r2).toEqual([]);
        expect(r3).toEqual([]);
        expect(fetchJsonWithRetry).toHaveBeenCalledTimes(3);
        expect(getCircuitBreakerState().tripped).toBe(true);
        expect(getCircuitBreakerState().consecutive503).toBe(3);

        // CRITICAL: 4th call MUST NOT issue HTTP (short-circuit).
        const r4 = await fetchAssaySummaryByCid(104);
        expect(r4).toEqual([]);
        expect(fetchJsonWithRetry).toHaveBeenCalledTimes(3);  // unchanged
    });

    it('3. success between 503s resets counter (no false-trip on intermittent failures)', async () => {
        vi.mocked(fetchJsonWithRetry)
            .mockRejectedValueOnce(new Error('HTTP 503: x (attempt 3/3)'))
            .mockRejectedValueOnce(new Error('HTTP 503: x (attempt 3/3)'))
            .mockResolvedValueOnce({ Table: { Row: [], Columns: { Column: [] } } })  // success
            .mockRejectedValueOnce(new Error('HTTP 503: x (attempt 3/3)'))
            .mockRejectedValueOnce(new Error('HTTP 503: x (attempt 3/3)'));

        await fetchAssaySummaryByCid(101);
        await fetchAssaySummaryByCid(102);
        // After 2 503s, counter=2 but not tripped.
        expect(getCircuitBreakerState().consecutive503).toBe(2);
        expect(getCircuitBreakerState().tripped).toBe(false);

        await fetchAssaySummaryByCid(103);  // success — reset
        expect(getCircuitBreakerState().consecutive503).toBe(0);
        expect(getCircuitBreakerState().tripped).toBe(false);

        await fetchAssaySummaryByCid(104);
        await fetchAssaySummaryByCid(105);
        // 2 fresh 503s after reset; still not tripped.
        expect(getCircuitBreakerState().consecutive503).toBe(2);
        expect(getCircuitBreakerState().tripped).toBe(false);
    });

    it('4. non-503 errors (e.g. HTTP 500, timeout) do NOT increment counter', async () => {
        vi.mocked(fetchJsonWithRetry)
            .mockRejectedValueOnce(new Error('HTTP 500: x (attempt 3/3)'))
            .mockRejectedValueOnce(new Error('AbortSignal timeout'))
            .mockRejectedValueOnce(new Error('Network unreachable'));

        await fetchAssaySummaryByCid(101);
        await fetchAssaySummaryByCid(102);
        await fetchAssaySummaryByCid(103);

        expect(getCircuitBreakerState().consecutive503).toBe(0);
        expect(getCircuitBreakerState().tripped).toBe(false);
    });

    it('5. tripped breaker stays tripped until resetCircuitBreaker() called (no auto-recovery)', async () => {
        vi.mocked(fetchJsonWithRetry).mockRejectedValue(
            new Error('HTTP 503: x (attempt 3/3)')
        );
        await fetchAssaySummaryByCid(101);
        await fetchAssaySummaryByCid(102);
        await fetchAssaySummaryByCid(103);
        expect(getCircuitBreakerState().tripped).toBe(true);

        // Even if PubChem "recovers" mid-process, short-circuit holds —
        // we don't probe (process boundary == reset boundary).
        vi.mocked(fetchJsonWithRetry).mockResolvedValue(
            { Table: { Row: [{ Cell: [] }], Columns: { Column: [] } } }
        );
        const r = await fetchAssaySummaryByCid(999);
        expect(r).toEqual([]);
        // mock NOT called for cid=999 (tripped short-circuit beats success)
        expect(fetchJsonWithRetry).toHaveBeenCalledTimes(3);

        resetCircuitBreaker();
        expect(getCircuitBreakerState().tripped).toBe(false);
        const r2 = await fetchAssaySummaryByCid(999);
        expect(fetchJsonWithRetry).toHaveBeenCalledTimes(4);  // probed post-reset
    });

    it('6. ANTI-REGRESSION: null/undefined cid still short-circuits without state mutation', async () => {
        const r1 = await fetchAssaySummaryByCid(null);
        const r2 = await fetchAssaySummaryByCid(undefined);
        const r3 = await fetchAssaySummaryByCid(0);
        expect(r1).toEqual([]);
        expect(r2).toEqual([]);
        expect(r3).toEqual([]);
        expect(fetchJsonWithRetry).not.toHaveBeenCalled();
        expect(getCircuitBreakerState().consecutive503).toBe(0);
    });

    it('7. trip-count increments per trip (resetCircuitBreaker zeroes it)', async () => {
        vi.mocked(fetchJsonWithRetry).mockRejectedValue(
            new Error('HTTP 503: x (attempt 3/3)')
        );
        await fetchAssaySummaryByCid(1);
        await fetchAssaySummaryByCid(2);
        await fetchAssaySummaryByCid(3);
        expect(getCircuitBreakerState().tripCount).toBe(1);
        resetCircuitBreaker();
        expect(getCircuitBreakerState().tripCount).toBe(0);
    });

    it('8. ANTI-REGRESSION: 2 consecutive 503 + 1 unrelated error does NOT trip (counter only increments on 503)', async () => {
        vi.mocked(fetchJsonWithRetry)
            .mockRejectedValueOnce(new Error('HTTP 503: x (attempt 3/3)'))
            .mockRejectedValueOnce(new Error('HTTP 503: x (attempt 3/3)'))
            .mockRejectedValueOnce(new Error('HTTP 500: x (attempt 3/3)'))
            .mockRejectedValueOnce(new Error('HTTP 503: x (attempt 3/3)'));

        await fetchAssaySummaryByCid(1);
        await fetchAssaySummaryByCid(2);
        await fetchAssaySummaryByCid(3);  // 500 -- does not increment (and does not reset either)
        await fetchAssaySummaryByCid(4);  // 503

        // Architect choice: 500 leaves counter alone (neither reset nor
        // increment). Counter stays at 2 then climbs to 3 on the next 503.
        expect(getCircuitBreakerState().consecutive503).toBe(3);
        expect(getCircuitBreakerState().tripped).toBe(true);
    });
});
