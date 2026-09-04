/**
 * Stage-3 cumulative merge helper (extracted from stage-3-aggregate.js
 * 2026-05-23 as part of PR-CORE-3 to keep the entry script under the
 * Art 5.1 250-line cap).
 *
 * Wraps the V0.5.2.1 cumulative aggregation logic: read the previous
 * aggregated bundle pointer, decide whether to merge / skip / abort
 * (per decideMergeAction), then either merge in-place or call
 * process.exit() with the right code for hard-fail cases.
 *
 * Per [[cross_cycle_silent_data_loss]]: this module preserves the
 * "halt on suspicious previous state" policy that prevents the 2026-05-19
 * F3 5000-record regression - it never falls back to per-cycle upload on
 * merge failure.
 *
 * Exit codes (matching stage-3-aggregate.js header):
 *   4 first_run sentinel present but pointer missing (operator surgery)
 *   5 previous bundle empty / partial-upload crash
 *   6 latest.json pointer schema malformed
 *   7 unexpected merge failure
 */

import { readStagePointer, downloadStageByRunId } from './r2-stage-bridge.js';
import { mergeLocalAggregatedWithPrevious, MERGE_FILES } from './aggregated-merger.js';
import { readFirstRunSentinel, decideMergeAction } from './aggregated-sentinel.js';

/**
 * Per-file merge telemetry. Extracted from executeCumulativeMerge so the
 * emission is a PURE function of the stats object: a unit test can assert
 * that a refusal is actually printed without creating a client, reading a
 * credential or touching R2.
 *
 * This is the ONLY consumer of the stats object. It printed a HARDCODED key
 * list, so a new counter key added upstream would have been silently
 * DISCARDED here -- a permanent, irreversible claim loss would have produced
 * no CI output at all. Adding a key the driver discards is not fail-soft-LOUD.
 */
export function logMergeStatsPerFile(perFile) {
    console.log('[STAGE-3] Merge stats per file:');
    for (const [fname, stats] of Object.entries(perFile)) {
        console.log(`  ${fname.padEnd(35)} total=${stats.total} (cur=${stats.from_current} prev_kept=${stats.from_previous_kept} replaced=${stats.replaced_by_current})`);
        if (typeof stats.merged_deep_total === 'number') {
            // PR-CORE-MERGE-LEAK telemetry: deep-merge per-file forensic counters.
            console.log(`    deep_merge: total=${stats.merged_deep_total} preserved_ext_id=${stats.merged_deep_preserved_external_id_fields} unioned_sources=${stats.merged_deep_unioned_sources_count} preserved_structural=${stats.merged_deep_preserved_structural_fields} preserved_f3=${stats.merged_deep_preserved_f3_fields}`);
            if (Array.isArray(stats.merged_deep_sample) && stats.merged_deep_sample.length > 0) {
                console.log(`    deep_merge_sample (first ${stats.merged_deep_sample.length} CIDs that gained preserved fields): ${stats.merged_deep_sample.join(', ')}`);
            }
        }
        // LANE3 3i fail-soft-LOUD: the merge never throws and never truncates
        // silently, so the refusal counters are the ONLY signal that claims
        // were permanently refused. They must reach the CI log.
        const claims = stats.merged_deep_claims;
        if (claims && typeof claims === 'object') {
            console.log(`    deep_merge_claims: records=${claims.records} claims_kept=${claims.claims_kept} preserved_kept=${claims.preserved_kept} revalidate_drops=${claims.revalidate_drops} nonfinite_rejected=${claims.nonfinite_rejected} overflow_refusals=${claims.overflow_refusals} overflow_records=${claims.overflow_records}`);
            if (Array.isArray(claims.sample) && claims.sample.length > 0) {
                // A sample is a record id plus an allow-listed path. NO VALUE.
                // console.log only; nothing here is ever written to R2.
                console.log(`    deep_merge_claims_sample (first ${claims.sample.length}, id + allow-listed path only): ${claims.sample.map(x => `${x.id}:${x.path}`).join(', ')}`);
            }
        }
        if (typeof stats.prev_bootstrap_count === 'number') {
            // PR-FDA-SRS-3c telemetry: prev-load mass-backfill (Option E unichem_matched).
            const sampleStr = Array.isArray(stats.prev_bootstrap_sample) ? stats.prev_bootstrap_sample.slice(0, 5).join(',') : '';
            console.log(`    prev_bootstrap: count=${stats.prev_bootstrap_count} sample=${sampleStr}`);
        }
        // LANE3 3j telemetry: the prev-load-boundary re-validation pass, which
        // is the ONLY re-validation that reaches prev-only records.
        const rv = stats.prev_claims_revalidate;
        if (rv && typeof rv === 'object') {
            const rvSample = Array.isArray(rv.sample) ? rv.sample.slice(0, 5).join(',') : '';
            console.log(`    prev_claims_revalidate: scanned=${rv.scanned} dropped=${rv.dropped} records_cleaned=${rv.records_cleaned} sample=${rvSample}`);
        }
    }
}

export async function executeCumulativeMerge(runId) {
    console.log('\n[STAGE-3] === Cumulative merge with previous aggregated ===');
    try {
        const prevPointer = await readStagePointer('aggregated');
        const firstRunDone = await readFirstRunSentinel();
        let previousBuffers = null;
        let prevBufferNonEmpty = false;
        if (prevPointer?.run_id && prevPointer.run_id !== runId) {
            previousBuffers = await downloadStageByRunId('aggregated', prevPointer.run_id, MERGE_FILES);
            const compoundsBuf = previousBuffers['compounds-enriched.jsonl'];
            prevBufferNonEmpty = (compoundsBuf?.length ?? 0) > 100;
        }
        const action = decideMergeAction({ prevPointer, runId, firstRunDone, prevBufferNonEmpty });
        switch (action.kind) {
            case 'first_run_skip':
                console.log('[STAGE-3] First-ever run (no sentinel, no pointer) - skipping merge, will mark sentinel after upload.');
                return;
            case 'sentinel_present_pointer_missing':
                console.error('[STAGE-3] FATAL: first_run_complete sentinel set but latest.json pointer missing - refusing merge (would clobber cumulative data). Operator must restore latest.json or remove sentinel before re-running.');
                process.exit(4);
                return;
            case 'pointer_missing_run_id':
                console.error('[STAGE-3] FATAL: latest.json pointer is missing run_id field - refusing merge (foreign writer / manual R2 PutObject suspected). Operator must rewrite processed/aggregated/latest.json with run_id field before re-running.');
                process.exit(6);
                return;
            case 'same_run_skip':
                console.log(`[STAGE-3] Pointer already references current run_id=${runId} (re-run) - skipping merge.`);
                return;
            case 'empty_buffer_abort':
                console.error('[STAGE-3] FATAL: Previous bundle compounds-enriched.jsonl empty/missing - refusing merge against empty previous (partial upload crash suspected). Operator must verify previous bundle integrity before re-running.');
                process.exit(5);
                return;
            case 'merge': {
                console.log(`[STAGE-3] Merging current cycle with previous aggregated run_id=${prevPointer.run_id}`);
                const totalBytesIn = Object.values(previousBuffers).reduce((s, b) => s + b.length, 0);
                console.log(`[STAGE-3] Downloaded ${MERGE_FILES.length} previous files (${(totalBytesIn / 1024).toFixed(1)} KB)`);
                const mergeResult = await mergeLocalAggregatedWithPrevious(previousBuffers);
                logMergeStatsPerFile(mergeResult.perFile);
                console.log(`[STAGE-3] Cumulative records across all files: ${mergeResult.totalMergedRecords}`);
                return;
            }
        }
    } catch (err) {
        // Per [[cross_cycle_silent_data_loss]]: never downgrade merge failure
        // to per-cycle upload - that's the exact silent-loss anti-pattern
        // that produced the 2026-05-19 5000-record regression. Hard-abort
        // so stage-4 never runs against downgraded data.
        console.error(`[STAGE-3] FATAL: Cumulative merge failed: ${err.message}`);
        console.error('[STAGE-3] Refusing to fall back to per-cycle upload - that would clobber historical compounds. Stage halted; investigate R2 connectivity / pointer schema / previous bundle integrity before re-running.');
        process.exit(7);
    }
}
