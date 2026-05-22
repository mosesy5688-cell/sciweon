/**
 * Tests for fetch-with-retry helper (cycle 21 PubChem outage resilience).
 *
 * Anchors the root-cause fix: a transient PubChem 503 burst used to
 * count every CID as a fetch_failure and overflow the cross-run retry
 * queue cap (F1 run 26269624764). With in-run retry the burst mostly
 * resolves on attempt 2 and never reaches the queue.
 */

import { describe, it, expect } from 'vitest';
import { fetchJsonWithRetry } from '../../scripts/factory/lib/fetch-with-retry.js';

function makeResponse(status: number, body: any = {}, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
    } as any;
}

describe('fetchJsonWithRetry', () => {
    it('returns parsed JSON on first success (no retry, no sleep)', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeResponse(200, { ok: true }); };
        const out = await fetchJsonWithRetry('https://x.test/a', { fetchImpl, baseDelayMs: 1 });
        expect(out).toEqual({ ok: true });
        expect(calls).toBe(1);
    });

    it('retries on 503 and succeeds on attempt 2', async () => {
        let calls = 0;
        const fetchImpl: any = async () => {
            calls++;
            return calls === 1 ? makeResponse(503) : makeResponse(200, { v: 42 });
        };
        const out = await fetchJsonWithRetry('https://x.test/b', { fetchImpl, baseDelayMs: 1, jitterMs: 0 });
        expect(out).toEqual({ v: 42 });
        expect(calls).toBe(2);
    });

    it('throws after maxAttempts on persistent 503', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeResponse(503); };
        await expect(
            fetchJsonWithRetry('https://x.test/c', { fetchImpl, maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }),
        ).rejects.toThrow(/HTTP 503/);
        expect(calls).toBe(3);
    });

    it('throws immediately on non-retry 4xx (no wasted attempts)', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeResponse(400); };
        await expect(
            fetchJsonWithRetry('https://x.test/d', { fetchImpl, maxAttempts: 5, baseDelayMs: 1 }),
        ).rejects.toThrow(/HTTP 400/);
        expect(calls).toBe(1);
    });

    it('retries on network error then succeeds', async () => {
        let calls = 0;
        const fetchImpl: any = async () => {
            calls++;
            if (calls === 1) throw new Error('ETIMEDOUT');
            return makeResponse(200, { v: 'recovered' });
        };
        const out = await fetchJsonWithRetry('https://x.test/e', { fetchImpl, baseDelayMs: 1, jitterMs: 0 });
        expect(out).toEqual({ v: 'recovered' });
        expect(calls).toBe(2);
    });

    it('returns null on 404 with allow404 (no retry)', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeResponse(404); };
        const out = await fetchJsonWithRetry('https://x.test/f', { fetchImpl, allow404: true, baseDelayMs: 1 });
        expect(out).toBeNull();
        expect(calls).toBe(1);
    });

    it('throws on 404 without allow404 (default behavior)', async () => {
        const fetchImpl: any = async () => makeResponse(404);
        await expect(
            fetchJsonWithRetry('https://x.test/g', { fetchImpl, baseDelayMs: 1 }),
        ).rejects.toThrow(/HTTP 404/);
    });

    it('honors numeric Retry-After header (and caps it)', async () => {
        let calls = 0;
        const t0 = Date.now();
        const fetchImpl: any = async () => {
            calls++;
            if (calls === 1) return makeResponse(429, undefined, { 'retry-after': '0' }); // 0 sec → ~immediate
            return makeResponse(200, { v: 'ok' });
        };
        const out = await fetchJsonWithRetry('https://x.test/h', { fetchImpl, maxRetryAfterMs: 100, baseDelayMs: 99999 });
        const elapsed = Date.now() - t0;
        expect(out).toEqual({ v: 'ok' });
        expect(elapsed).toBeLessThan(500); // confirms Retry-After=0 used instead of huge baseDelayMs
    });

    it('caps Retry-After at maxRetryAfterMs (hostile upstream protection)', async () => {
        let calls = 0;
        const t0 = Date.now();
        const fetchImpl: any = async () => {
            calls++;
            if (calls === 1) return makeResponse(429, undefined, { 'retry-after': '99999' });
            return makeResponse(200, {});
        };
        await fetchJsonWithRetry('https://x.test/i', { fetchImpl, maxRetryAfterMs: 50, baseDelayMs: 1 });
        expect(Date.now() - t0).toBeLessThan(500); // confirms cap kicked in
    });
});
