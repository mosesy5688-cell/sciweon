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
 */

import { spawn } from 'child_process';
import path from 'path';
import { downloadStage, uploadStage, deriveRunId, readStagePointer, downloadStageByRunId } from './lib/r2-stage-bridge.js';
import { mergeLocalAggregatedWithPrevious, MERGE_FILES } from './lib/aggregated-merger.js';

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
        if (!prevPointer || !prevPointer.run_id || prevPointer.run_id === runId) {
            console.log('[STAGE-3] No previous aggregated bundle (first run or same run_id) — skipping merge.');
        } else {
            console.log(`[STAGE-3] Merging current cycle with previous aggregated run_id=${prevPointer.run_id}`);
            const previousBuffers = await downloadStageByRunId('aggregated', prevPointer.run_id, MERGE_FILES);
            const totalBytesIn = Object.values(previousBuffers).reduce((s, b) => s + b.length, 0);
            console.log(`[STAGE-3] Downloaded ${MERGE_FILES.length} previous files (${(totalBytesIn / 1024).toFixed(1)} KB)`);
            const mergeResult = await mergeLocalAggregatedWithPrevious(previousBuffers);
            console.log('[STAGE-3] Merge stats per file:');
            for (const [fname, stats] of Object.entries(mergeResult.perFile)) {
                console.log(`  ${fname.padEnd(35)} total=${stats.total} (cur=${stats.from_current} prev_kept=${stats.from_previous_kept} replaced=${stats.replaced_by_current})`);
            }
            console.log(`[STAGE-3] Cumulative records across all files: ${mergeResult.totalMergedRecords}`);
        }
    } catch (err) {
        // Merge failure must NOT block stage upload — fall back to per-cycle
        // (existing pre-V0.5.2.1 behavior) rather than halting the chain.
        // The merge gap will surface as historical-CID 0-result on next
        // source-health check, alerting operators without losing fresh data.
        console.error(`[STAGE-3] Cumulative merge failed (non-fatal): ${err.message}`);
        console.error('[STAGE-3] Falling back to per-cycle aggregated upload — historical compounds may disappear from API view until next successful merge.');
    }

    console.log('\n[STAGE-3] === Upload aggregated bundle to R2 ===');
    try {
        await uploadStage('aggregated', runId, AGGREGATED_FILES);
    } catch (err) {
        console.error(`[STAGE-3] R2 upload failed: ${err.message}`);
        process.exit(3);
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
