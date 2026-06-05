// @ts-nocheck
/**
 * PR-FAERS-KEY (Step-5b): openfda-adapter URL-keying + sentinel via the real
 * fetch path (global fetch mocked -- NO network, ci.yml stays hermetic).
 *
 * Asserts:
 *   - each of the 3 URL builders includes &api_key=<URL-encoded> when the key
 *     is set, and the request actually hits api.fda.gov endpoints.
 *   - a sentinel key in a 500 error never appears in any captured warn/throw.
 *   - status-class sentinel: 404 -> [] (genuine empty); 500 -> null (failure).
 *   - FAERS saturation: results.length >= limit -> truncated:true.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    fetchLabelsByUnii, fetchFaersSignalsByUnii, fetchRecallsByUnii,
} from '../../scripts/ingestion/adapters/openfda-adapter.js';

function makeResponse(status: number, body: any = {}, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
    } as any;
}

describe('openfda-adapter -- api_key wiring + sentinel', () => {
    let savedKey; let savedFetch; let captured: string[];
    beforeEach(() => {
        savedKey = process.env.OPENFDA_API_KEY;
        savedFetch = globalThis.fetch;
        captured = [];
        vi.spyOn(console, 'warn').mockImplementation((...a) => captured.push(a.join(' ')));
    });
    afterEach(() => {
        if (savedKey === undefined) delete process.env.OPENFDA_API_KEY;
        else process.env.OPENFDA_API_KEY = savedKey;
        globalThis.fetch = savedFetch;
        vi.restoreAllMocks();
    });

    it('all 3 builders include &api_key=<encoded> and hit the right endpoints', async () => {
        process.env.OPENFDA_API_KEY = 'KEY 123';
        const urls: string[] = [];
        globalThis.fetch = vi.fn(async (u) => { urls.push(String(u)); return makeResponse(200, { results: [] }); });

        await fetchLabelsByUnii('U1', 5);
        await fetchFaersSignalsByUnii('U1', 30);
        await fetchRecallsByUnii('U1', 10);

        expect(urls.length).toBe(3);
        for (const u of urls) expect(u).toContain('api_key=KEY%20123');
        expect(urls[0]).toContain('/drug/label.json');
        expect(urls[1]).toContain('/drug/event.json');
        expect(urls[2]).toContain('/drug/enforcement.json');
    });

    it('no key set -> URL carries no api_key (keyless degrade)', async () => {
        delete process.env.OPENFDA_API_KEY;
        const urls: string[] = [];
        globalThis.fetch = vi.fn(async (u) => { urls.push(String(u)); return makeResponse(200, { results: [] }); });
        await fetchLabelsByUnii('U1', 5);
        expect(urls[0]).not.toContain('api_key=');
    });

    it('P0: a 500 with a sentinel key never leaks the key in any warn line', async () => {
        process.env.OPENFDA_API_KEY = 'SECRET123';
        globalThis.fetch = vi.fn(async () => makeResponse(500));
        const out = await fetchFaersSignalsByUnii('U1', 30);
        expect(out).toBeNull();   // fetch-failure sentinel
        expect(captured.length).toBeGreaterThan(0);
        for (const line of captured) {
            expect(line).not.toContain('SECRET123');
            expect(line).toContain('api_key=REDACTED');
        }
    });

    it('status-class sentinel: 404 -> genuine empty; 500 -> null failure', async () => {
        process.env.OPENFDA_API_KEY = 'k';
        // 404 -> [] (labels/recalls) and { terms:[] } (faers)
        globalThis.fetch = vi.fn(async () => makeResponse(404));
        expect(await fetchLabelsByUnii('U1')).toEqual([]);
        expect(await fetchRecallsByUnii('U1')).toEqual([]);
        expect(await fetchFaersSignalsByUnii('U1')).toEqual({ terms: [], truncated: false });
        // 500 -> null on all three (fetch failure)
        globalThis.fetch = vi.fn(async () => makeResponse(500));
        expect(await fetchLabelsByUnii('U1')).toBeNull();
        expect(await fetchRecallsByUnii('U1')).toBeNull();
        expect(await fetchFaersSignalsByUnii('U1')).toBeNull();
    });

    it('FAERS saturation: results.length >= limit -> truncated:true', async () => {
        process.env.OPENFDA_API_KEY = 'k';
        const results = Array.from({ length: 30 }, (_, i) => ({ term: `T${i}`, count: i }));
        globalThis.fetch = vi.fn(async () => makeResponse(200, { results }));
        const out = await fetchFaersSignalsByUnii('U1', 30);
        expect(out.truncated).toBe(true);
        expect(out.terms.length).toBe(30);
    });

    it('FAERS not saturated: results.length < limit -> truncated:false', async () => {
        process.env.OPENFDA_API_KEY = 'k';
        globalThis.fetch = vi.fn(async () => makeResponse(200, { results: [{ term: 'X', count: 1 }] }));
        const out = await fetchFaersSignalsByUnii('U1', 30);
        expect(out.truncated).toBe(false);
    });
});
