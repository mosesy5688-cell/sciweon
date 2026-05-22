/**
 * V0.5.6 — Stage-1 incremental-worker cursor-advance decision.
 *
 * Pattern A closure for [[feedback_cross_cycle_silent_data_loss]] in the
 * incremental ingest layer. When the V2 adapter reports `hasUpdates=true`
 * but `fetchIncremental` returns 0 records, the worker MUST hold the cursor
 * — advancing it would slide past a window of data that the adapter
 * believed existed, creating a permanent unrecoverable gap.
 *
 * Cycle 21 — Pattern A2: the early-exit probe path (`hasUpdates=false`)
 * also must NOT trust the adapter's `nextSinceToken`. DailyMed + WHO-ATC
 * both return `nextSinceToken: today` from `checkForUpdates` regardless of
 * whether a fetch is happening. If the worker advances the cursor in this
 * branch, the next probe asks "anything since today?" — always 0 for
 * DailyMed (publishes nightly, not same-day) and for WHO-ATC keeps
 * `daysSince(today)=0 < fallbackFullRefreshDays=30`, locking the cursor
 * forever. Symptom: drug-labels.jsonl never published; atc_class enrichment
 * never fires; `[ADAPTER-LINKER] WHO-ATC: 0 codes | DailyMed RxCUI: 0` on
 * every cron. Fix: hold the cursor on early-exit too — same Pattern A rule,
 * symmetric.
 *
 * Pure function: integration caller writes the cursor object via
 * `writeIncrementalCursor` from incremental-cursors.js.
 */

export function decideCursorAdvance({
    recordsLength, currentSinceToken, nextSinceToken, source, hasUpdates = true,
}) {
    if (!hasUpdates) {
        return {
            kind: 'no_updates_hold',
            cursorUpdate: {
                sinceToken: currentSinceToken,
                status: 'no_updates',
                record_count: 0,
            },
            message: `${source}: probe reports hasUpdates=false — cursor held at ${currentSinceToken} (Pattern A2: do not trust probe nextSinceToken).`,
        };
    }
    if (recordsLength === 0) {
        return {
            kind: 'anomaly_zero_fetch_hold',
            cursorUpdate: {
                sinceToken: currentSinceToken,
                status: 'anomaly_zero_fetch',
                record_count: 0,
            },
            message: `${source}: hasUpdates=true but fetchIncremental returned 0 records — cursor held to retry next run (Pattern A defense).`,
        };
    }
    return {
        kind: 'advance',
        cursorUpdate: {
            sinceToken: nextSinceToken,
            status: 'success',
            record_count: recordsLength,
        },
    };
}
