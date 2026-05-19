/**
 * V0.5.6 — Stage-1 incremental-worker cursor-advance decision.
 *
 * Pattern A closure for [[feedback_cross_cycle_silent_data_loss]] in the
 * incremental ingest layer. When the V2 adapter reports `hasUpdates=true`
 * but `fetchIncremental` returns 0 records, the worker MUST hold the cursor
 * — advancing it would slide past a window of data that the adapter
 * believed existed, creating a permanent unrecoverable gap.
 *
 * The next scheduled cron retries from the held `sinceToken`. Status
 * `'anomaly_zero_fetch'` is queryable via the R2 cursor object so future
 * health-monitor wave (I-5) can flag sources stuck in that state.
 *
 * Pure function: integration caller writes the cursor object via
 * `writeIncrementalCursor` from incremental-cursors.js.
 */

export function decideCursorAdvance({ recordsLength, currentSinceToken, nextSinceToken, source }) {
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
