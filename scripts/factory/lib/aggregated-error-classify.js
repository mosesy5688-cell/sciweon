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
 * processed/aggregated/latest.json is written by two producers:
 *   - r2-stage-bridge.uploadStage (stage-3-aggregate)      -> {run_id, ...}
 *   - incremental-merge-helpers.uploadAggregated (fan-in)  -> {pointer, ...}
 *
 * Fan-in's loadPreviousAggregated only knows how to consume the latter.
 * If it reads a pointer written by stage-3, the missing `.pointer` field
 * would otherwise route through the data-404 path and surface as
 * `orphaned_pointer` (technically wrong — the pointer was never ours).
 *
 * This decision separates that case so fan-in can bootstrap cleanly
 * (return empty Map) while still throwing on real orphan / corruption.
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
