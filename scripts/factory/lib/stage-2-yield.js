/**
 * V0.5.6 — Stage-2 per-enricher yield check.
 *
 * Defense-in-depth for [[feedback_cross_cycle_silent_data_loss]] — Pattern A
 * 3rd occurrence. stage-2 enrichers do in-place mutation of
 * compounds-enriched.jsonl and bioactivities.jsonl; a buggy enricher can exit 0
 * yet wipe the file to 0 records, and (before this gate) the stage would
 * happily upload the empty bundle to R2.
 *
 * Pure function: integration callers count records via `countJsonlRecords`
 * from snapshot-history-gate.js, then pass the result here.
 *
 * Behavior:
 *   - currentRecords === 0 → kind: 'zero_records_abort' (operator must investigate)
 *   - currentRecords  >  0 → kind: 'pass'
 *
 * Delta-based aborts (records dropped but not to zero) are intentionally NOT
 * handled here — stage-4 historical comparison [[decideGateAction]] owns that
 * regression check via its own threshold gate.
 */

export function decideYieldAction({ currentRecords, taskName, yieldFile }) {
    if (currentRecords === 0) {
        return {
            kind: 'zero_records_abort',
            message: `${taskName} produced 0 records in ${yieldFile} — exit-0-with-0-records silent loss (Pattern A).`,
        };
    }
    return { kind: 'pass', currentRecords };
}
