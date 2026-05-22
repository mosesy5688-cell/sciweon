/**
 * Cycle 21 PR #5 — DailyMed adapter API-shape lock.
 *
 * The adapter previously read `data.metadata.total` which doesn't exist
 * in the DailyMed v2 response. Every cron silently produced 0 records
 * for unknown days. Combined with worker cursor poisoning, this blocked
 * drug-labels publication entirely.
 *
 * This test locks the real-world API response shape so the parser stays
 * aligned. Fixture captured live 2026-05-22 from
 *   GET https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json
 *       ?startdate=2026-05-15&pagesize=1&page=1&labeltype=HUMAN+PRESCRIPTION+DRUG
 *
 * [[feedback_local_verify_external_api]]: assumption-not-verification is
 * the upstream bug class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the fetcher module's fetchJson before importing the adapter.
vi.mock('../../scripts/ingestion/adapters/dailymed-fetcher.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../scripts/ingestion/adapters/dailymed-fetcher.js')>();
    return {
        ...actual,
        fetchJson: vi.fn(),
        listSplPage: vi.fn(),
        fetchLabelMeta: vi.fn(),
        fetchSections: vi.fn(),
    };
});

import { checkForUpdates } from '../../scripts/ingestion/adapters/dailymed-adapter.js';
import * as fetcher from '../../scripts/ingestion/adapters/dailymed-fetcher.js';

const LIVE_RESPONSE_2026_05_22 = {
    data: [{
        spl_version: 1,
        published_date: 'May 21, 2026',
        title: 'VERAPAMIL HYDROCHLORIDE TABLET [ZYDUS LIFESCIENCES LIMITED]',
        setid: '051392d3-8ec1-450c-8c38-791d4ef1a2db',
    }],
    metadata: {
        db_published_date: 'May 21, 2026 09:26:50PM EST',
        elements_per_page: 1,
        current_url: 'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?startdate=2026-05-15&pagesize=1&page=1&labeltype=HUMAN+PRESCRIPTION+DRUG',
        next_page_url: 'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?startdate=2026-05-15&pagesize=1&page=2&labeltype=HUMAN+PRESCRIPTION+DRUG',
        total_elements: 156505,
        total_pages: 156505,
        current_page: 1,
        previous_page: 'null',
        previous_page_url: 'null',
        next_page: 2,
    },
};

describe('dailymed checkForUpdates — live API shape lock', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('reads total_elements (not total) and reports hasUpdates correctly', async () => {
        vi.mocked(fetcher.fetchJson).mockResolvedValue(LIVE_RESPONSE_2026_05_22);
        const r = await checkForUpdates('2026-05-15');
        expect(r.hasUpdates).toBe(true);
        expect(r.count).toBe(156505);
    });

    it('absent total_elements falls back to 0 (defensive)', async () => {
        vi.mocked(fetcher.fetchJson).mockResolvedValue({ data: [], metadata: {} });
        const r = await checkForUpdates('2026-05-15');
        expect(r.hasUpdates).toBe(false);
        expect(r.count).toBe(0);
    });

    it('the OLD bug shape (metadata.total) does NOT accidentally re-match', async () => {
        // Regression guard: if someone reverts to `data.metadata?.total`,
        // a response containing only `total` (legacy) would still report 0
        // because we exclusively read total_elements per the live API.
        vi.mocked(fetcher.fetchJson).mockResolvedValue({
            data: [], metadata: { total: 999 }, // old assumed shape
        });
        const r = await checkForUpdates('2026-05-15');
        expect(r.count).toBe(0); // confirms we're not reading legacy `total`
    });
});
