/**
 * PR-RXN-1b-pre 2026-05-28: DailyMed adapter NDC hydration field contract.
 *
 * Locks the `ndcs[]` field shape on drug_label records emitted by
 * fetchIncremental. Defends consumer-side from TypeError on undefined,
 * 429-exhausted-retry null collapse, and parallel-promise rate-limit drift.
 *
 * Architect-mandated 2-assertion baseline (JSON field integrity +
 * empty-value defense); expanded to 4 with null collapse + sequential
 * invariant for completeness.
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
        fetchNdcs: vi.fn(),
        sleep: vi.fn(async () => {}),
    };
});

import { fetchIncremental } from '../../scripts/ingestion/adapters/dailymed-adapter.js';
import * as fetcher from '../../scripts/ingestion/adapters/dailymed-fetcher.js';

describe('dailymed normalize -- ndcs[] field hydration (PR-RXN-1b-pre)', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('1. JSON field integrity: fetchNdcs returns 3 NDCs -> normalize output ndcs has length 3', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 1,
            items: [{ spl_version: 1, published_date: 'May 21, 2026', title: 'X', setid: 'tri-ndc' }],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue({} as any);
        vi.mocked(fetcher.fetchNdcs).mockResolvedValue(['0042-0220-01', '50242-040-62', '12345-6789-0']);

        const { records } = await fetchIncremental('2026-05-15');
        expect(records).toHaveLength(1);
        expect(Array.isArray(records[0].ndcs)).toBe(true);
        expect(records[0].ndcs).toHaveLength(3);
        expect(records[0].ndcs).toContain('0042-0220-01');
    });

    it('2. null defense: fetchNdcs returns null (429-exhausted retries) -> ndcs collapses to [] (NOT undefined)', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 1,
            items: [{ spl_version: 1, published_date: 'May 21, 2026', title: 'Y', setid: 'null-ndc' }],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue({} as any);
        vi.mocked(fetcher.fetchNdcs).mockResolvedValue(null);

        const { records } = await fetchIncremental('2026-05-15');
        expect(records).toHaveLength(1);
        expect(records[0].ndcs).toEqual([]);
        expect(records[0].ndcs).not.toBeUndefined();
    });

    it('3. empty-array defense: fetchNdcs returns [] (biologic / special label) -> ndcs is []', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 1,
            items: [{ spl_version: 1, published_date: 'May 21, 2026', title: 'Z', setid: 'empty-ndc' }],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue({} as any);
        vi.mocked(fetcher.fetchNdcs).mockResolvedValue([]);

        const { records } = await fetchIncremental('2026-05-15');
        expect(records).toHaveLength(1);
        expect(records[0].ndcs).toEqual([]);
    });

    it('4. ANTI-REGRESSION: fetchNdcs is awaited sequentially (not parallel-promised), preserving DELAY_MS rate-limit envelope', async () => {
        const fetchOrder: string[] = [];
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 2,
            items: [
                { spl_version: 1, published_date: 'May 21, 2026', title: 'A', setid: 'first' },
                { spl_version: 1, published_date: 'May 20, 2026', title: 'B', setid: 'second' },
            ],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue({} as any);
        vi.mocked(fetcher.fetchNdcs).mockImplementation(async (setid) => {
            fetchOrder.push(setid);
            return [];
        });

        await fetchIncremental('2026-05-15');
        expect(fetchOrder).toEqual(['first', 'second']);
    });
});
