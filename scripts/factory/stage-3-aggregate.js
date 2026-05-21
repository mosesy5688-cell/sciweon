/**
 * Stage 3/4 — Aggregate (V0.5.x refactor)
 *
 * Reads enriched bundle from R2, runs trial / paper / cross-link / neg-evidence
 * scripts, uploads aggregated bundle to R2 processed/aggregated/<run_id>/.
 *
 * Inputs (R2):
 *   processed/enriched/<latest>/compounds-enriched.jsonl
 *   processed/enriched/<latest>/bioactivities.jsonl
 *
 * Outputs (R2):
 *   processed/aggregated/<run_id>/compounds-enriched.jsonl
 *   processed/aggregated/<run_id>/bioactivities.jsonl
 *   processed/aggregated/<run_id>/trials.jsonl
 *   processed/aggregated/<run_id>/trial-links.jsonl
 *   processed/aggregated/<run_id>/papers.jsonl
 *   processed/aggregated/<run_id>/paper-links.jsonl
 *   processed/aggregated/<run_id>/negative-evidence-raw.jsonl
 *   processed/aggregated/<run_id>/neg-evidence.jsonl
 *   processed/aggregated/latest.json
 *
 * Exit codes:
 *   0  all phases OK
 *   1  some adapters failed (degraded - uploaded what completed)
 *   2  enriched download failed (no input)
 *   3  R2 upload failed
 *   4  first_run sentinel set but latest.json pointer missing (operator surgery)
 *   5  previous bundle empty / partial-upload crash suspected
 *   6  latest.json pointer schema malformed (missing run_id field)
 *   7  cumulative merge unexpected failure
 */

import { spawn } from 'child_process';
import path from 'path';
import { downloadStage, uploadStage, deriveRunId, readStagePointer, downloadStageByRunId } from './lib/r2-stage-bridge.js';
import { mergeLocalAggregatedWithPrevious, MERGE_FILES } from './lib/aggregated-merger.js';
import { buildIndex as buildSearchIndex, OUTPUT_FILE as SEARCH_INDEX_FILE } from './lib/search-index-builder.js';
import { buildIndex as buildTargetIndex, OUTPUT_FILE as TARGET_INDEX_FILE } from './lib/target-index-builder.js';
import { readFirstRunSentinel, writeFirstRunSentinel, decideMergeAction } from './lib/aggregated-sentinel.js';

const SCRIPT_DIR = 'scripts/factory';
const AGGREGATED_FILES = [
    'compounds-enriched.jsonl',
    'bioactivities.jsonl',
    'trials.jsonl',
    'trial-links.jsonl',
    'papers.jsonl',
    'paper-links.jsonl',
    'negative-evidence-raw.jsonl',
    'neg-evidence.jsonl',
    'sciweon-search-index.json',
    'target-index.json',
];

function runScript(name) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [path.join(SCRIPT_DIR, name)], {
            stdio: 'inherit',
            env: { ...process.env },
        });
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`${name} exit ${code}`)));
        child.on('error', reject);
    });
}

async function runSequential(label, tasks) {
    console.log(`\n[STAGE-3] === ${label} (sequential) ===`);
    const summaries = [];
    for (const t of tasks) {
        try {
            await t.fn();
            summaries.push({ task: t.name, ok: true, error: null });
        } catch (err) {
            // V0.5.x policy (2026-05-15): any sub-script failure halts the stage
            // IMMEDIATELY. Do NOT continue and do NOT let `uploadStage` run on
            // partial data — bad data must never pollute production R2.
            console.error(`[STAGE-3] ${label}/${t.name} failed: ${err.message}`);
            summaries.push({ task: t.name, ok: false, error: err.message });
            throw new Error(`[STAGE-3] ${label}/${t.name} failed — stage aborted before R2 upload to prevent pollution. Original error: ${err.message}`);
        }
    }
    return summaries;
}

async function main() {
    const startTime = Date.now();
    const runId = deriveRunId();
    console.log(`[STAGE-3] Sciweon Factory Aggregate V0.5.x run_id=${runId}`);

    console.log('\n[STAGE-3] === Download enriched from R2 ===');
    try {
        await downloadStage('enriched', ['compounds-enriched.jsonl', 'bioactivities.jsonl']);
    } catch (err) {
        console.error(`[STAGE-3] Enriched download failed: ${err.message}`);
        process.exit(2);
    }

    // V0.5.x: trial scripts must run sequentially — both trial-linker and
    // trial-results-enricher do writeFile on trials.jsonl, so parallel runs
    // produce last-writer-wins. trial-linker is slowest, so it overwrites
    // trial-results-enricher's serious_events_count enrichment, leaving
    // neg-evidence-builder with no source data for serious_adverse_event_per_trial
    // (cycle 1 audit: 0 records of that category vs 161 in V0.4.3 local).
    // ctis-trial-linker uses appendFile (safe) but ordering it after trial-linker
    // keeps the appended records aligned with the freshly-written base file.
    // Papers writes a different file so the trial-group and paper-group can still
    // run in parallel with each other.
    const [trialResults, paperResults] = await Promise.all([
        runSequential('Trials', [
            { name: 'trial-linker', fn: () => runScript('trial-linker.js') },
            { name: 'ctis-trial-linker', fn: () => runScript('ctis-trial-linker.js') },
            { name: 'trial-results-enricher', fn: () => runScript('trial-results-enricher.js') },
        ]),
        runSequential('Papers', [
            { name: 'paper-linker', fn: () => runScript('paper-linker.js') },
        ]),
    ]);

    const crossLinkResults = await runSequential('Cross-link + Negative Evidence', [
        { name: 'bidirectional-linker', fn: () => runScript('bidirectional-linker.js') },
        { name: 'neg-evidence-builder', fn: () => runScript('neg-evidence-builder.js') },
    ]);

    // V0.5.2.1 cumulative aggregation: merge this cycle's outputs with the
    // PREVIOUSLY-published aggregated bundle. Without this step each cycle
    // would completely replace the API-visible state and historical CIDs
    // would disappear (cross-cycle silent data loss anti-pattern).
    // Replace-by-id (newer cycle wins) for retry-queue / re-harvest cases.
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
                console.log('[STAGE-3] First-ever run (no sentinel, no pointer) — skipping merge, will mark sentinel after upload.');
                break;
            case 'sentinel_present_pointer_missing':
                console.error('[STAGE-3] FATAL: first_run_complete sentinel set but latest.json pointer missing — refusing merge (would clobber cumulative data). Operator must restore latest.json or remove sentinel before re-running.');
                process.exit(4);
                break;
            case 'pointer_missing_run_id':
                console.error('[STAGE-3] FATAL: latest.json pointer is missing run_id field — refusing merge (foreign writer / manual R2 PutObject suspected). Operator must rewrite processed/aggregated/latest.json with run_id field before re-running.');
                process.exit(6);
                break;
            case 'same_run_skip':
                console.log(`[STAGE-3] Pointer already references current run_id=${runId} (re-run) — skipping merge.`);
                break;
            case 'empty_buffer_abort':
                console.error('[STAGE-3] FATAL: Previous bundle compounds-enriched.jsonl empty/missing — refusing merge against empty previous (partial upload crash suspected). Operator must verify previous bundle integrity before re-running.');
                process.exit(5);
                break;
            case 'merge': {
                console.log(`[STAGE-3] Merging current cycle with previous aggregated run_id=${prevPointer.run_id}`);
                const totalBytesIn = Object.values(previousBuffers).reduce((s, b) => s + b.length, 0);
                console.log(`[STAGE-3] Downloaded ${MERGE_FILES.length} previous files (${(totalBytesIn / 1024).toFixed(1)} KB)`);
                const mergeResult = await mergeLocalAggregatedWithPrevious(previousBuffers);
                console.log('[STAGE-3] Merge stats per file:');
                for (const [fname, stats] of Object.entries(mergeResult.perFile)) {
                    console.log(`  ${fname.padEnd(35)} total=${stats.total} (cur=${stats.from_current} prev_kept=${stats.from_previous_kept} replaced=${stats.replaced_by_current})`);
                }
                console.log(`[STAGE-3] Cumulative records across all files: ${mergeResult.totalMergedRecords}`);
                break;
            }
        }
    } catch (err) {
        // Per [[feedback_cross_cycle_silent_data_loss]] — a swallowed merge
        // failure that downgrades to per-cycle upload is the exact silent-loss
        // anti-pattern that produced the 2026-05-19 F3 5000-record regression.
        // Hard-abort instead so stage-4 never runs against downgraded data.
        console.error(`[STAGE-3] FATAL: Cumulative merge failed: ${err.message}`);
        console.error('[STAGE-3] Refusing to fall back to per-cycle upload — that would clobber historical compounds. Stage halted; investigate R2 connectivity / pointer schema / previous bundle integrity before re-running.');
        process.exit(7);
    }

    // V0.5.3 Tier 1.5 search index — rebuild SQLite FTS5 over cumulative
    // aggregated. Runs AFTER the cumulative merge so the index reflects
    // historical + current compounds together. Failure here is non-fatal:
    // search endpoint returns "index unavailable, fallback to ID lookup"
    // rather than halting the chain (search is enhancement, not lifeline).
    console.log('\n[STAGE-3] === Build Tier 1.5 search index (FTS5) ===');
    try {
        const stats = await buildSearchIndex({
            outputPath: path.join('./output/linked', SEARCH_INDEX_FILE),
        });
        console.log(`[STAGE-3] Search index: ${stats.compoundCount + stats.trialCount + stats.paperCount} total rows, ${(stats.sizeBytes / 1024 / 1024).toFixed(1)} MB in ${stats.elapsedSec}s`);
    } catch (err) {
        console.error(`[STAGE-3] Search index build failed (non-fatal): ${err.message}`);
        console.error('[STAGE-3] Will upload aggregated bundle without search index; previous cycle\'s index remains current in R2 until next successful build.');
    }

    // C2-3 target inverse-pivot index. Non-fatal: /api/v1/target/* 404s
    // if absent, rest of bundle ships.
    console.log('\n[STAGE-3] === Build target inverse-pivot index ===');
    try {
        const s = await buildTargetIndex({ outputPath: path.join('./output/linked', TARGET_INDEX_FILE) });
        console.log(`[STAGE-3] Target index: ${s.targetCount} targets, ${s.bioactivitiesIndexed} bioacts, ${s.trialEdges} trial edges, ${s.negEvidenceEdges} neg edges, ${(s.sizeBytes / 1024 / 1024).toFixed(2)} MB in ${s.elapsedSec}s`);
    } catch (err) {
        console.error(`[STAGE-3] Target index build failed (non-fatal): ${err.message}`);
    }

    console.log('\n[STAGE-3] === Upload aggregated bundle to R2 ===');
    try {
        await uploadStage('aggregated', runId, AGGREGATED_FILES);
    } catch (err) {
        console.error(`[STAGE-3] R2 upload failed: ${err.message}`);
        process.exit(3);
    }

    // V0.5.5 — mark first_run_complete sentinel after successful upload.
    // Subsequent runs use this sentinel to distinguish legitimate first-run
    // skip from "sentinel missing == bootstrap forgot to merge".
    // Non-fatal: failure to write sentinel does not invalidate this upload.
    try {
        await writeFirstRunSentinel(runId);
    } catch (err) {
        console.warn(`[STAGE-3] Failed to write first_run_complete sentinel (non-fatal): ${err.message}`);
    }

    const failureCount = trialResults.filter(r => !r.ok).length
        + paperResults.filter(r => !r.ok).length
        + crossLinkResults.filter(r => !r.ok).length;

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STAGE-3] === Summary ===`);
    console.log(`  Elapsed:           ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  Trials OK:         ${trialResults.filter(r => r.ok).length}/3`);
    console.log(`  Papers OK:         ${paperResults.filter(r => r.ok).length}/1`);
    console.log(`  Cross-link OK:     ${crossLinkResults.filter(r => r.ok).length}/2`);
    console.log(`  R2 run prefix:     processed/aggregated/${runId}/`);

    if (failureCount > 0) {
        console.warn('[STAGE-3] Completed with degraded aggregation');
        process.exit(1);
    }
    console.log('[STAGE-3] All phases OK, stage 4 will pick up');
    process.exit(0);
}

main().catch(err => {
    console.error('[STAGE-3] Fatal:', err.message);
    process.exit(1);
});
