// @ts-nocheck
/**
 * PR-T1.1a R3: openFDA skip+limit pagination to completion.
 *
 * Locks: full-set collection across pages; MAX_PAGES_PER_UNII LOUD bound;
 * ANY page failure -> null sentinel (never stamp a partial as complete).
 */

import { describe, it, expect } from 'vitest';
import { fetchAllPages, MAX_PAGES_PER_UNII } from '../../scripts/factory/lib/openfda-paginate.js';

// A paged fake openFDA endpoint over an in-memory dataset. Honors skip+limit
// and reports meta.results.total (the authoritative full-set size).
function pagedFetch(dataset, { failAtSkip } = {}) {
    return async (url) => {
        const skip = Number(new URL(url, 'https://x').searchParams.get('skip') ?? 0);
        const limit = Number(new URL(url, 'https://x').searchParams.get('limit') ?? 1000);
        if (failAtSkip != null && skip === failAtSkip) throw new Error('boom 500');
        const slice = dataset.slice(skip, skip + limit);
        if (slice.length === 0 && skip > 0) return { meta: { results: { total: dataset.length } }, results: [] };
        return { meta: { results: { total: dataset.length } }, results: slice };
    };
}

const buildUrl = (skip, limit) => `https://api.fda.gov/drug/label.json?skip=${skip}&limit=${limit}`;

describe('fetchAllPages -- completion', () => {
    it('collects the FULL set across multiple pages', async () => {
        const data = Array.from({ length: 2499 }, (_, i) => ({ i }));
        const out = await fetchAllPages(pagedFetch(data), buildUrl, { pageLimit: 1000 });
        expect(out.results.length).toBe(2499);
        expect(out.truncated).toBe(false);
    });

    it('single page (< limit) returns all, not truncated', async () => {
        const data = Array.from({ length: 13 }, (_, i) => ({ i }));
        const out = await fetchAllPages(pagedFetch(data), buildUrl, { pageLimit: 1000 });
        expect(out.results.length).toBe(13);
        expect(out.truncated).toBe(false);
    });

    it('genuine-empty (404 -> null body) returns empty, not truncated', async () => {
        const out = await fetchAllPages(async () => null, buildUrl, { pageLimit: 1000 });
        expect(out.results).toEqual([]);
        expect(out.truncated).toBe(false);
    });
});

describe('fetchAllPages -- MAX_PAGES LOUD bound', () => {
    it('hits maxPages before draining -> truncated:true (flagged, not silent)', async () => {
        const data = Array.from({ length: 100 }, (_, i) => ({ i }));
        const out = await fetchAllPages(pagedFetch(data), buildUrl, { pageLimit: 10, maxPages: 3 });
        expect(out.results.length).toBe(30);   // 3 pages * 10
        expect(out.truncated).toBe(true);
    });

    it('MAX_PAGES_PER_UNII default exported is a wide bound', () => {
        expect(MAX_PAGES_PER_UNII).toBeGreaterThanOrEqual(50);
    });
});

describe('fetchAllPages -- page-failure sentinel', () => {
    it('a failure on page 0 -> null (never partial)', async () => {
        const data = Array.from({ length: 50 }, (_, i) => ({ i }));
        const out = await fetchAllPages(pagedFetch(data, { failAtSkip: 0 }), buildUrl, { pageLimit: 10 });
        expect(out).toBeNull();
    });

    it('a failure on a LATER page -> null (do NOT stamp the collected prefix)', async () => {
        const data = Array.from({ length: 50 }, (_, i) => ({ i }));
        // page 0 (skip0) ok, page 1 (skip10) fails -> the whole call is null.
        const out = await fetchAllPages(pagedFetch(data, { failAtSkip: 10 }), buildUrl, { pageLimit: 10 });
        expect(out).toBeNull();
    });
});
