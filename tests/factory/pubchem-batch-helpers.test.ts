/**
 * PR-1 F1-harvest fault fix -- regression lock for the PubChem batch helpers.
 *
 * pubchem-adapter.js called an undefined `fetchJson` in three helpers. The
 * LIVE one -- fetchFingerprint2DBatch (stage-2 compound-fingerprint-enricher,
 * every stage-2 cron) -- swallowed the ReferenceError in its per-chunk catch
 * and returned an EMPTY Map, so the enricher stamped 0/N CACTVS fingerprints
 * and exited 0: a silent production data-loss. These tests are network-free
 * (mock the global fetch / inject fetchImpl) and lock:
 *   1. fetchJsonWithRetry POST passthrough (method/body forwarded, signal LAST).
 *   2. batchFetchSynonyms -> Map keyed String(CID); 404 -> empty; 5xx -> THROWS.
 *   3. batchFetchProperties -> in-run 503 retry; persistent 400 -> throws.
 *   4. fetchFingerprint2DBatch -> stamps N/N (THE regression-lock for the loss).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJsonWithRetry } from '../../scripts/factory/lib/fetch-with-retry.js';
import {
    batchFetchSynonyms,
    batchFetchProperties,
    fetchFingerprint2DBatch,
} from '../../scripts/ingestion/adapters/pubchem-adapter.js';

function makeResponse(status: number, body: any = {}, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
    } as any;
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── 1. fetchJsonWithRetry POST passthrough (method/body forwarded; signal LAST)
describe('fetchJsonWithRetry — requestInit POST passthrough', () => {
    it('forwards method+body+headers and keeps the (un-clobbered) AbortSignal', async () => {
        let seenInit: any = null;
        const fetchImpl: any = async (_url: string, init: any) => { seenInit = init; return makeResponse(200, { ok: true }); };
        const out = await fetchJsonWithRetry('https://x.test/post', {
            fetchImpl, baseDelayMs: 1,
            requestInit: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'cid=1,2,3' },
        });
        expect(out).toEqual({ ok: true });
        expect(seenInit.method).toBe('POST');
        expect(seenInit.body).toBe('cid=1,2,3');
        expect(seenInit.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        // signal must be the run timeout AbortSignal, NOT clobbered by requestInit.
        expect(seenInit.signal).toBeInstanceOf(AbortSignal);
    });

    it('a caller signal in requestInit cannot clobber the timeout signal (spread last)', async () => {
        let seenInit: any = null;
        const bogus = new AbortController().signal;
        const fetchImpl: any = async (_url: string, init: any) => { seenInit = init; return makeResponse(200, {}); };
        await fetchJsonWithRetry('https://x.test/post2', {
            fetchImpl, baseDelayMs: 1, requestInit: { method: 'POST', signal: bogus },
        });
        expect(seenInit.signal).not.toBe(bogus);
        expect(seenInit.signal).toBeInstanceOf(AbortSignal);
    });

    it('POST 503 retries then succeeds (status logic is method-agnostic)', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return calls === 1 ? makeResponse(503) : makeResponse(200, { v: 7 }); };
        const out = await fetchJsonWithRetry('https://x.test/post3', { fetchImpl, baseDelayMs: 1, jitterMs: 0, requestInit: { method: 'POST', body: 'cid=1' } });
        expect(out).toEqual({ v: 7 });
        expect(calls).toBe(2);
    });

    it('POST 400 throws immediately (no wasted attempts)', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeResponse(400); };
        await expect(
            fetchJsonWithRetry('https://x.test/post4', { fetchImpl, maxAttempts: 5, baseDelayMs: 1, requestInit: { method: 'POST', body: 'cid=1' } }),
        ).rejects.toThrow(/HTTP 400/);
        expect(calls).toBe(1);
    });
});

// ── 2. batchFetchSynonyms — String(CID) key; 404 -> empty Map; 5xx -> THROWS
describe('batchFetchSynonyms', () => {
    it('returns a Map keyed by String(CID) with the synonyms (non-empty)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, {
            InformationList: { Information: [
                { CID: 2244, Synonym: ['aspirin', 'acetylsalicylic acid'] },
                { CID: 3672, Synonym: ['ibuprofen'] },
            ] },
        })));
        const map = await batchFetchSynonyms([2244, 3672]);
        expect(map.get('2244')).toEqual(['aspirin', 'acetylsalicylic acid']);
        expect(map.get('3672')).toEqual(['ibuprofen']);
        expect(map.size).toBe(2);
    });

    it('404 -> empty Map (allow404, no throw)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => makeResponse(404)));
        const map = await batchFetchSynonyms([999999999]);
        expect(map.size).toBe(0);
    });

    it('persistent 500 (exhausted) -> THROWS (visibility, not a masked empty Map)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => makeResponse(500)));
        await expect(batchFetchSynonyms([2244])).rejects.toThrow(/HTTP 500/);
    });
});

// ── 3. batchFetchProperties — in-run 503 retry now present; persistent 400 throws
describe('batchFetchProperties', () => {
    it('503-then-200 -> returns the properties (proves in-run retry now present)', async () => {
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            calls++;
            return calls === 1 ? makeResponse(503) : makeResponse(200, { PropertyTable: { Properties: [{ CID: 2244, MolecularWeight: '180.16' }] } });
        }));
        const props = await batchFetchProperties([2244]);
        expect(props).toHaveLength(1);
        expect(props[0].CID).toBe(2244);
        expect(calls).toBe(2);
    });

    it('persistent 400 -> throws "HTTP 400" (the clean 4xx PR-2 will bisect on)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => makeResponse(400)));
        await expect(batchFetchProperties([2244])).rejects.toThrow(/HTTP 400/);
    });
});

// ── 4. fetchFingerprint2DBatch — stamps N/N. THE regression-lock for the live loss.
describe('fetchFingerprint2DBatch (live-loss regression lock)', () => {
    it('stamps N/N: Map.size === cids.length, keys String(CID)', async () => {
        const cids = ['2244', '3672', '5090'];
        vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, {
            PropertyTable: { Properties: cids.map(c => ({ CID: Number(c), Fingerprint2D: `FP_${c}` })) },
        })));
        const map = await fetchFingerprint2DBatch(cids, 100);
        expect(map.size).toBe(cids.length); // old undefined-fetchJson path -> empty Map
        expect(map.get('2244')).toBe('FP_2244');
        expect(map.get('3672')).toBe('FP_3672');
        expect(map.get('5090')).toBe('FP_5090');
    });

    it('a 404 chunk contributes nothing (allow404) but does NOT throw the run', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => makeResponse(404)));
        const map = await fetchFingerprint2DBatch(['1', '2'], 100);
        expect(map.size).toBe(0);
    });
});
