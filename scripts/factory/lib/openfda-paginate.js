/**
 * openFDA skip+limit pagination to completion (PR-T1.1a, R3).
 *
 * The label/recall adapters historically fetched a single capped page (label
 * limit 5, recall limit 10) -> a compound with > limit labels/recalls silently
 * lost the tail. The probe measured label up to 2499 (~3 pages @ 1000) and
 * recall up to 13 (1 page). This helper drives the skip+limit loop through the
 * SAME fetchOpenFda (the ONE shared TokenBucket + retry path) until the full
 * `meta.results.total` set is collected.
 *
 * SENTINEL CONTRACT ([[cross_cycle_silent_data_loss]]): fetchOpenFda returns
 * the parsed body on 200, null on a genuine 404 (empty), and THROWS
 * OpenFdaFetchError on a FETCH FAILURE (429/5xx/timeout/network). If ANY page
 * throws, this helper returns null (a FETCH FAILURE for the whole call) so the
 * caller does NOT stamp a partial page set as a complete result. A LOUD
 * truncated flag is set if MAX_PAGES_PER_UNII is hit before total is reached
 * (a runaway bound, NOT a silent cut -- the flag surfaces it).
 *
 * Returns { results, truncated } on success/genuine-empty; null on any page
 * fetch failure.
 */

// Per-call page bound. label tops ~3 pages @ pageLimit 1000; 50 is a wide
// LOUD runaway guard (a UNII needing > 50 pages is an anomaly, flagged not
// silently truncated).
export const MAX_PAGES_PER_UNII = 50;

/**
 * @param {(url:string)=>Promise<any|null>} fetchJson  fetchOpenFda (throws on
 *   FETCH FAILURE, null on 404). Injected for test hermeticity.
 * @param {(skip:number, limit:number)=>string} buildUrl  page-URL builder.
 * @param {object} [opts] { pageLimit=1000, maxPages=MAX_PAGES_PER_UNII }
 * @returns {Promise<{results:Array, truncated:boolean}|null>}
 */
export async function fetchAllPages(fetchJson, buildUrl, opts = {}) {
    const pageLimit = opts.pageLimit ?? 1000;
    const maxPages = opts.maxPages ?? MAX_PAGES_PER_UNII;
    const results = [];
    let skip = 0;
    let total = Infinity;
    let pages = 0;

    while (skip < total && pages < maxPages) {
        let data;
        try {
            data = await fetchJson(buildUrl(skip, pageLimit));
        } catch (e) {
            // FETCH FAILURE on ANY page -> whole call fails (never stamp a
            // partial set as complete). Return the null sentinel; the caller
            // logs + keeps the record eligible for the next cron.
            return null;
        }
        // null = genuine 404. On page 0 that is a genuine-empty result set;
        // on a later page it means the tail vanished (treat as done).
        const page = data?.results ?? [];
        if (page.length === 0) break;
        results.push(...page);
        pages += 1;
        // meta.results.total is the authoritative full-set size.
        const metaTotal = data?.meta?.results?.total;
        if (Number.isFinite(metaTotal)) total = metaTotal;
        else if (page.length < pageLimit) break; // no meta -> last short page
        skip += page.length;
    }

    // LOUD truncation: hit the page bound before draining the full set.
    const truncated = pages >= maxPages && results.length < total;
    return { results, truncated };
}
