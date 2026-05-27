// @ts-nocheck
/**
 * PR-RXN-1 hotfix: release discovery tests.
 * Locks first-Monday-of-month computation + HEAD-probe fallback chain.
 */

import { describe, it, expect } from 'vitest';
import {
    firstMondayOfMonth, formatMMDDYYYY, formatIsoDate,
    buildCandidateUrls, findLatestPrescribableUrl,
} from '../../scripts/factory/lib/rxnorm-release-discovery.js';

describe('PR-RXN-1 hotfix: firstMondayOfMonth', () => {
    it('1. 2026-05 first Monday is May 4', () => {
        const d = firstMondayOfMonth(2026, 5);
        expect(formatIsoDate(d)).toBe('2026-05-04');
    });

    it('2. 2026-06 first Monday is June 1', () => {
        const d = firstMondayOfMonth(2026, 6);
        expect(formatIsoDate(d)).toBe('2026-06-01');
    });

    it('3. 2026-01 first Monday is January 5', () => {
        // 2026-01-01 is Thursday; first Monday is Jan 5.
        const d = firstMondayOfMonth(2026, 1);
        expect(formatIsoDate(d)).toBe('2026-01-05');
    });

    it('4. 2027-02 first Monday is February 1 (Mon falls on 1st)', () => {
        // 2027-02-01 is Monday.
        const d = firstMondayOfMonth(2027, 2);
        expect(formatIsoDate(d)).toBe('2027-02-01');
    });
});

describe('PR-RXN-1 hotfix: buildCandidateUrls', () => {
    it('5. newest-first ordering with N month window', () => {
        const now = new Date(Date.UTC(2026, 4, 15));  // May 15 2026
        const candidates = buildCandidateUrls(3, now);
        expect(candidates).toHaveLength(3);
        expect(candidates[0].release_date).toBe('2026-05-04');
        expect(candidates[1].release_date).toBe('2026-04-06');
        expect(candidates[2].release_date).toBe('2026-03-02');
    });

    it('6. URL pattern matches RxNorm_full_prescribe_MMDDYYYY.zip', () => {
        const now = new Date(Date.UTC(2026, 4, 15));
        const candidates = buildCandidateUrls(1, now);
        expect(candidates[0].url).toBe('https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_05042026.zip');
        expect(candidates[0].filename).toBe('RxNorm_full_prescribe_05042026.zip');
    });

    it('7. year boundary: January falls back to previous year December', () => {
        const now = new Date(Date.UTC(2026, 0, 15));  // Jan 15 2026
        const candidates = buildCandidateUrls(2, now);
        expect(candidates[0].release_date).toBe('2026-01-05');
        expect(candidates[1].release_date).toBe('2025-12-01');
    });
});

describe('PR-RXN-1 hotfix: findLatestPrescribableUrl', () => {
    it('8. returns first 200 OK candidate', async () => {
        const candidates = [
            { url: 'http://a/', filename: 'a', release_date: '2026-05-04' },
            { url: 'http://b/', filename: 'b', release_date: '2026-04-06' },
        ];
        const headFetch = async (u) => ({ ok: u === 'http://a/', status: u === 'http://a/' ? 200 : 404, headers: new Map([['last-modified', 'Mon, 04 May 2026 12:00:00 GMT']]) });
        const res = await findLatestPrescribableUrl(candidates, async (u) => {
            const fake = await headFetch(u);
            return { ok: fake.ok, status: fake.status, headers: { get: (k) => fake.headers.get(k) } };
        });
        expect(res.url).toBe('http://a/');
        expect(res.release_date).toBe('2026-05-04');
        expect(res.last_modified).toMatch(/2026/);
    });

    it('9. falls through to second candidate when first returns 404', async () => {
        const candidates = [
            { url: 'http://newest/', filename: 'a', release_date: '2026-06-01' },
            { url: 'http://prev/', filename: 'b', release_date: '2026-05-04' },
        ];
        const res = await findLatestPrescribableUrl(candidates, async (u) => ({
            ok: u === 'http://prev/',
            status: u === 'http://prev/' ? 200 : 404,
            headers: { get: () => null },
        }));
        expect(res.url).toBe('http://prev/');
        expect(res.release_date).toBe('2026-05-04');
    });

    it('10. throws when no candidate returns 200', async () => {
        const candidates = [{ url: 'http://x/', filename: 'x', release_date: '2026-05-04' }];
        await expect(findLatestPrescribableUrl(candidates, async () => ({
            ok: false, status: 404, headers: { get: () => null },
        }))).rejects.toThrow(/no prescribable release found/);
    });

    it('11. network error on one candidate falls through to next', async () => {
        const candidates = [
            { url: 'http://err/', filename: 'a', release_date: '2026-06-01' },
            { url: 'http://ok/', filename: 'b', release_date: '2026-05-04' },
        ];
        const res = await findLatestPrescribableUrl(candidates, async (u) => {
            if (u === 'http://err/') throw new Error('ECONNRESET');
            return { ok: true, status: 200, headers: { get: () => null } };
        });
        expect(res.url).toBe('http://ok/');
    });
});
