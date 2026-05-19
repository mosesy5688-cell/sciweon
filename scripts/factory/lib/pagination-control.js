/**
 * V0.5.7 — Shared pagination loop control for V2 adapters.
 *
 * Each V2 adapter (clinicaltrials / pubmed / openalex / ctis) historically
 * issued a single API call with pageSize=200 and silently dropped any
 * record beyond. This helper provides:
 *   - shouldFetchNextPage: pure decision (continue / stop_exhausted /
 *                          stop_record_cap / stop_page_cap)
 *   - nextSinceTokenAfterLoop: cursor-correctness — advance to today only
 *                              when provider was actually exhausted;
 *                              otherwise hold at sinceToken so next cron
 *                              retries the same window idempotently
 *                              ([[feedback_cross_cycle_silent_data_loss]]
 *                              partial-fetch protection).
 *
 * Per-provider pagination URL/body construction stays in each adapter —
 * only the loop-termination decision is shared.
 */

export const DEFAULT_MAX_RECORDS = 5000;
export const DEFAULT_MAX_PAGES = 50;

export function shouldFetchNextPage({
    recordsFetched,
    pagesDone,
    hasMoreSignal,
    maxRecords = DEFAULT_MAX_RECORDS,
    maxPages = DEFAULT_MAX_PAGES,
}) {
    if (!hasMoreSignal) return { kind: 'stop_exhausted' };
    if (recordsFetched >= maxRecords) return { kind: 'stop_record_cap', cap: maxRecords };
    if (pagesDone >= maxPages) return { kind: 'stop_page_cap', cap: maxPages };
    return { kind: 'continue' };
}

export function nextSinceTokenAfterLoop({ stopKind, sinceToken, today }) {
    return stopKind === 'stop_exhausted' ? today : sinceToken;
}
