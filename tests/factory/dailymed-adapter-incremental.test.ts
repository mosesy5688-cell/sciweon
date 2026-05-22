/**
 * Cycle 21 PR #8 — DailyMed incremental adapter scope shrink.
 *
 * Split from dailymed-adapter-shape.test.ts (constitution Art 5.1
 * ≤250 lines per file). Covers the bootstrap window + client-side date
 * cutoff + early-stop behavior introduced when the server-side
 * `startdate` filter was found broken (returns full 156505-label corpus
 * regardless of value).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../scripts/ingestion/adapters/dailymed-fetcher.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../scripts/ingestion/adapters/dailymed-fetcher.js')>();
    return {
        ...actual,
        fetchJson: vi.fn(),
        listSplPage: vi.fn(),
        fetchLabelMeta: vi.fn(),
        fetchSections: vi.fn(),
        sleep: vi.fn(async () => {}),
    };
});

import { fetchIncremental } from '../../scripts/ingestion/adapters/dailymed-adapter.js';
import * as fetcher from '../../scripts/ingestion/adapters/dailymed-fetcher.js';

describe('dailymed PR #8 — incremental slim', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('normalizeDailyMedDate handles "May 21, 2026" textual format', async () => {
        const { normalizeDailyMedDate } = await import('../../scripts/ingestion/adapters/dailymed-fetcher.js');
        expect(normalizeDailyMedDate('May 21, 2026')).toBe('2026-05-21');
        expect(normalizeDailyMedDate('January 3, 2025')).toBe('2025-01-03');
        expect(normalizeDailyMedDate('Sept 9, 2024')).toBe('2024-09-09');
        expect(normalizeDailyMedDate('Dec 31, 2026')).toBe('2026-12-31');
        // Existing formats still work
        expect(normalizeDailyMedDate('05/21/2026')).toBe('2026-05-21');
        expect(normalizeDailyMedDate('2026-05-21')).toBe('2026-05-21');
        // Unknown format passes through (defensive)
        expect(normalizeDailyMedDate('garbage-string')).toBe('garbage-string');
        expect(normalizeDailyMedDate(null)).toBeNull();
    });

    it('bootstrapSince returns today − 1 day (not today − 7 days)', async () => {
        const { bootstrapSince } = await import('../../scripts/ingestion/adapters/dailymed-fetcher.js');
        const expectedDate = new Date();
        expectedDate.setDate(expectedDate.getDate() - 1);
        const expected = expectedDate.toISOString().slice(0, 10);
        expect(bootstrapSince()).toBe(expected);
    });

    it('fetchIncremental early-stops on first item older than sinceToken', async () => {
        // List sorted desc by published_date; client cutoff @ 2026-05-21
        // should accept the 2026-05-22 + 2026-05-21 items and stop at
        // 2026-05-20 — never fetching the 2026-05-19 / 2026-05-18 records.
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 5,
            items: [
                { spl_version: 1, published_date: 'May 22, 2026', title: 'NEW',     setid: 'item-22' },
                { spl_version: 1, published_date: 'May 21, 2026', title: 'CUTOFF',  setid: 'item-21' },
                { spl_version: 1, published_date: 'May 20, 2026', title: 'OLD',     setid: 'item-20' },
                { spl_version: 1, published_date: 'May 19, 2026', title: 'OLDER',   setid: 'item-19' },
                { spl_version: 1, published_date: 'May 18, 2026', title: 'OLDEST',  setid: 'item-18' },
            ],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue(null);

        const { records } = await fetchIncremental('2026-05-21');

        expect(records).toHaveLength(2);
        expect(records[0].setid).toBe('item-22');
        expect(records[1].setid).toBe('item-21');
        // Crucially: fetchSections NOT called for the old items
        expect(vi.mocked(fetcher.fetchSections).mock.calls.map(c => c[0])).toEqual(['item-22', 'item-21']);
    });

    it('fetchIncremental processes all items when none reach the cutoff', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 2,
            items: [
                { spl_version: 1, published_date: 'May 22, 2026', title: 'A', setid: 'a' },
                { spl_version: 1, published_date: 'May 22, 2026', title: 'B', setid: 'b' },
            ],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue(null);

        const { records } = await fetchIncremental('2026-05-15');

        expect(records).toHaveLength(2);
    });

    it('fetchIncremental does NOT early-stop on unparseable published_date (conservative)', async () => {
        // If date can't be normalized to YYYY-MM-DD, fall through to process
        // the item — don't accidentally drop legitimate records due to a
        // future API format change. Client cutoff is the only date filter
        // we trust; behave conservatively when it can't apply.
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 2,
            items: [
                { spl_version: 1, published_date: 'NOT-A-DATE', title: 'A', setid: 'a' },
                { spl_version: 1, published_date: 'May 18, 2026', title: 'B', setid: 'b' },
            ],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue(null);

        const { records } = await fetchIncremental('2026-05-21');

        // Item A processed (unparseable → no cutoff applied)
        // Item B triggers early-stop (May 18 < May 21)
        expect(records).toHaveLength(1);
        expect(records[0].setid).toBe('a');
    });
});
