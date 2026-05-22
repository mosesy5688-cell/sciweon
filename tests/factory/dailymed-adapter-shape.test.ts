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
        sleep: vi.fn(async () => {}),
    };
});

import { checkForUpdates, fetchIncremental } from '../../scripts/ingestion/adapters/dailymed-adapter.js';
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

// Cycle 21 PR #6 — bypass /spls/{setid}.json (HTTP 415 server regression).
// Adapter now constructs meta from list-page item directly + relies on the
// labeltype=HUMAN PRESCRIPTION DRUG filter that listSplPage applies.
describe('dailymed fetchIncremental — meta from list item (no fetchLabelMeta)', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    const LIST_ITEMS = [
        { spl_version: 1, published_date: 'May 21, 2026', title: 'VERAPAMIL HCl TABLET', setid: 'aaaa-aaaa' },
        { spl_version: 2, published_date: 'May 20, 2026', title: 'ASPIRIN TABLET',        setid: 'bbbb-bbbb' },
    ];

    it('builds meta from list item fields without calling fetchLabelMeta', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({ total: 2, items: LIST_ITEMS });
        vi.mocked(fetcher.fetchSections).mockResolvedValue({
            adverse_reactions: 'Sample adverse reactions text.',
        } as any);

        const { records } = await fetchIncremental('2026-05-15');

        expect(vi.mocked(fetcher.fetchLabelMeta)).not.toHaveBeenCalled();
        expect(records).toHaveLength(2);
        expect(records[0].setid).toBe('aaaa-aaaa');
        expect(records[0].title).toBe('VERAPAMIL HCl TABLET');
        expect(records[0].spl_version).toBe('1');
        // PR #8 extended normalizeDailyMedDate to handle textual months
        // (needed for client-side date cutoff). "May 21, 2026" → ISO.
        expect(records[0].published_date).toBe('2026-05-21');
        // label_type hardcoded — list endpoint pre-filters to HUMAN PRESCRIPTION
        expect(records[0].label_type).toBe('HUMAN PRESCRIPTION DRUG');
        // Stage-A: rxcui/application_numbers/dosage_forms intentionally empty
        // (Stage-B will extract from SPL XML in cycle 22)
        expect(records[0].rxcui).toEqual([]);
        expect(records[0].application_numbers).toEqual([]);
        expect(records[0].dosage_forms).toEqual([]);
        // sections still come from ZIP — C2-7's adverse_reactions text preserved
        expect(records[0].sections.adverse_reactions).toBe('Sample adverse reactions text.');
        expect(records[0].sections_extracted).toBe(true);
    });

    it('still emits a record when fetchSections returns null (sections_extracted=false)', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({ total: 1, items: [LIST_ITEMS[0]] });
        vi.mocked(fetcher.fetchSections).mockResolvedValue(null);

        const { records } = await fetchIncremental('2026-05-15');

        expect(records).toHaveLength(1);
        expect(records[0].sections_extracted).toBe(false);
        // buildNullSections fills with nulls — preserves shape for downstream
        expect(records[0].sections).toBeTruthy();
    });

    it('skips items lacking setid (defensive)', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({
            total: 2,
            items: [{ ...LIST_ITEMS[0], setid: null }, LIST_ITEMS[1]],
        });
        vi.mocked(fetcher.fetchSections).mockResolvedValue(null);

        const { records } = await fetchIncremental('2026-05-15');

        expect(records).toHaveLength(1);
        expect(records[0].setid).toBe('bbbb-bbbb');
    });

    it('a single fetchSections failure is non-fatal — other records still emit', async () => {
        vi.mocked(fetcher.listSplPage).mockResolvedValue({ total: 2, items: LIST_ITEMS });
        vi.mocked(fetcher.fetchSections)
            .mockRejectedValueOnce(new Error('Network blip'))
            .mockResolvedValueOnce(null);

        const { records } = await fetchIncremental('2026-05-15');

        expect(records).toHaveLength(1);
        expect(records[0].setid).toBe('bbbb-bbbb');
    });
});

// Cycle 21 PR #7 — DailyMed archive ZIP endpoint URL changed
// (/dailymed/archives/{setid}.zip 302s to homepage now). Lock the
// current working URL pattern so a future drift fails CI not prod.
describe('dailymed archive URL + ZIP magic guard', () => {
    it('exports the getFile.cfm constant (not the broken /archives path)', async () => {
        const m = await import('../../scripts/ingestion/adapters/dailymed-fetcher.js');
        expect(m.DAILYMED_GETFILE).toContain('getFile.cfm');
        expect(m.DAILYMED_GETFILE).not.toContain('/archives');
    });
});

// Cycle 21 PR #8 — incremental adapter scope shrink: client-side date
// cutoff + early-stop + 1-day bootstrap. DailyMed v2 `startdate` param
// is broken server-side; full corpus would time out daily cron.
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

