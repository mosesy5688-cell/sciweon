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
