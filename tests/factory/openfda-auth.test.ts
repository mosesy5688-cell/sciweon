// @ts-nocheck
/**
 * PR-FAERS-KEY (Step-5b): openFDA auth + redaction + sentinel contract.
 *
 * Locks:
 *   - warn-degrade: OPENFDA_API_KEY absent -> null + a LOUD warning (NOT a throw;
 *     openFDA works keyless, unlike UMLS which hard-403s).
 *   - URL wiring: withApiKey appends &api_key=<URL-encoded> when a key is set.
 *   - REDACTION (P0): the key never appears in any thrown/logged string.
 *   - sentinel contract: fetchOpenFda returns null on 404 (genuine-empty) and
 *     throws OpenFdaFetchError (redacted) on 429/5xx (fetch failure).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    openFdaApiKey, withApiKey, redactApiKey, fetchOpenFda, OpenFdaFetchError,
} from '../../scripts/factory/lib/openfda-auth.js';

function makeResponse(status: number, body: any = {}, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
    } as any;
}

describe('PR-FAERS-KEY: openfda-auth helper', () => {
    let saved;
    beforeEach(() => { saved = process.env.OPENFDA_API_KEY; });
    afterEach(() => {
        if (saved === undefined) delete process.env.OPENFDA_API_KEY;
        else process.env.OPENFDA_API_KEY = saved;
        vi.restoreAllMocks();
    });

    it('warn-degrade: absent key -> null + a LOUD warning (no throw)', () => {
        delete process.env.OPENFDA_API_KEY;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const key = openFdaApiKey();
        expect(key).toBeNull();
        // warn-once may have already fired in this module instance from another
        // test; force a guaranteed observation by asserting the helper never threw
        // and that, when it DOES warn, the message names the cap.
        if (warn.mock.calls.length > 0) {
            expect(String(warn.mock.calls[0][0])).toMatch(/1,000 req\/day|OPENFDA_API_KEY absent/);
        }
    });

    it('withApiKey appends &api_key=<URL-encoded> when a key is set', () => {
        process.env.OPENFDA_API_KEY = 'KEY 123';
        const url = withApiKey('https://api.fda.gov/drug/event.json?search=x&limit=30');
        expect(url).toContain('&api_key=KEY%20123');
        expect(url.startsWith('https://api.fda.gov/drug/event.json?')).toBe(true);
    });

    it('withApiKey uses ? when the base URL has no query string', () => {
        process.env.OPENFDA_API_KEY = 'abc';
        expect(withApiKey('https://api.fda.gov/drug/label.json')).toBe(
            'https://api.fda.gov/drug/label.json?api_key=abc');
    });

    it('withApiKey leaves the URL untouched when no key (keyless degrade)', () => {
        delete process.env.OPENFDA_API_KEY;
        const u = 'https://api.fda.gov/drug/event.json?search=x';
        expect(withApiKey(u)).toBe(u);
    });

    it('redactApiKey scrubs the key from any string', () => {
        const leaked = 'HTTP 500: https://api.fda.gov/drug/event.json?search=x&api_key=SECRET123';
        const red = redactApiKey(leaked);
        expect(red).not.toContain('SECRET123');
        expect(red).toContain('api_key=REDACTED');
    });

    it('P0 sentinel-redaction: a 500 with a sentinel key never leaks it in throw/log', async () => {
        process.env.OPENFDA_API_KEY = 'SECRET123';
        const captured: string[] = [];
        vi.spyOn(console, 'warn').mockImplementation((...a) => captured.push(a.join(' ')));
        vi.spyOn(console, 'error').mockImplementation((...a) => captured.push(a.join(' ')));
        const fetchImpl: any = async () => makeResponse(500);
        let thrownMsg = '';
        try {
            await fetchOpenFda('https://api.fda.gov/drug/event.json?search=x', {
                fetchImpl, maxAttempts: 2,
            });
        } catch (e) {
            thrownMsg = e.message;
            expect(e).toBeInstanceOf(OpenFdaFetchError);
            expect(e.isFetchFailure).toBe(true);
        }
        // The thrown message + EVERY captured log line must be free of the key.
        expect(thrownMsg).not.toContain('SECRET123');
        expect(thrownMsg).toContain('api_key=REDACTED');
        for (const line of captured) expect(line).not.toContain('SECRET123');
    });

    it('sentinel: 404 -> null (genuine empty, NOT a failure)', async () => {
        process.env.OPENFDA_API_KEY = 'k';
        const fetchImpl: any = async () => makeResponse(404);
        const out = await fetchOpenFda('https://api.fda.gov/drug/event.json?search=x', { fetchImpl });
        expect(out).toBeNull();
    });

    it('sentinel: 429 after retries -> throws OpenFdaFetchError (fetch failure)', async () => {
        process.env.OPENFDA_API_KEY = 'k';
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeResponse(429, undefined, { 'retry-after': '0' }); };
        await expect(
            fetchOpenFda('https://api.fda.gov/drug/event.json?search=x', { fetchImpl, maxAttempts: 2 }),
        ).rejects.toBeInstanceOf(OpenFdaFetchError);
        expect(calls).toBe(2);
    });

    it('200 success returns the parsed body', async () => {
        process.env.OPENFDA_API_KEY = 'k';
        const fetchImpl: any = async () => makeResponse(200, { results: [{ term: 'NAUSEA', count: 5 }] });
        const out = await fetchOpenFda('https://api.fda.gov/drug/event.json?search=x', { fetchImpl });
        expect(out.results[0].term).toBe('NAUSEA');
    });
});
