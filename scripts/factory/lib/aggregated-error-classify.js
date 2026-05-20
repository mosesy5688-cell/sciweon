/**
 * V0.5.6 — `loadPreviousAggregated` error classifier.
 *
 * Pattern A closure for [[feedback_cross_cycle_silent_data_loss]] in the
 * cumulative-merge load path. The previous bare `catch {}` returned an
 * empty Map on every failure mode, masking orphaned pointers, transient
 * S3 errors, and gzip / JSON corruption. Stage-3 then silently merged
 * against an empty baseline and clobbered the cumulative state.
 *
 * Only one error mode is "legitimate first run": 404 NoSuchKey on the
 * `latest.json` pointer. Every other error must surface so the operator
 * can investigate before the pipeline overwrites authoritative data.
 *
 * Pure function: integration caller in `incremental-merge-helpers.js`
 * decides whether to return an empty Map (only on `first_run`) or throw.
 */

function is404(err) {
    return err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

export function classifyPreviousAggregatedError(err, stage) {
    if (stage === 'pointer' && is404(err)) {
        return { kind: 'first_run', message: 'no previous cumulative — starting fresh' };
    }
    if (stage === 'data' && is404(err)) {
        return {
            kind: 'orphaned_pointer',
            message: 'pointer references missing all-records.jsonl.gz — orphaned pointer, manual investigation required',
        };
    }
    return {
        kind: 'transient_or_corrupted',
        message: `${stage} load failed: ${err?.message ?? String(err)}`,
    };
}

/**
 * V0.5.7.1 — pointer-shape decision.
 *
 * Historical context: processed/aggregated/latest.json was originally
 * written by TWO producers with different schemas:
 *   - r2-stage-bridge.uploadStage (stage-3-aggregate)      -> {run_id, ...}
 *   - incremental-merge-helpers.uploadAggregated (fan-in)  -> {pointer, ...}
 *
 * Last writer won; the other consumer broke (stage-3 hard-aborted on
 * `pointer_missing_run_id`, surfaced 2026-05-20 PR #89).
 *
 * V0.6 fix: fan-in moved to its own key `processed/aggregated/fanin-latest.json`.
 * stage-3 now solely owns `processed/aggregated/latest.json`.
 * classifyPointerShape stays as defense-in-depth in case operator hand-writes
 * the wrong shape into either key (PR #75-style read-side tolerance).
 */
export function classifyPointerShape(ptr) {
    if (!ptr || typeof ptr !== 'object') {
        return { kind: 'malformed_pointer', message: 'pointer is not an object' };
    }
    if (typeof ptr.pointer === 'string' && ptr.pointer.length > 0) {
        return { kind: 'fan_in_compatible', pointer: ptr.pointer };
    }
    const knownKeys = Object.keys(ptr).sort().join(', ');
    return {
        kind: 'foreign_schema',
        message: `pointer lacks fan-in 'pointer' field (keys present: [${knownKeys}]) — likely written by stage-3-aggregate (uses 'run_id'). Fan-in bootstrapping with empty Map.`,
    };
}
