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
import { downloadStage, uploadStage, deriveRunId } from './lib/r2-stage-bridge.js';
import { executeCumulativeMerge } from './lib/stage-3-merge.js';
import { buildIndex as buildSearchIndex, OUTPUT_FILE as SEARCH_INDEX_FILE } from './lib/search-index-builder.js';
import { buildIndex as buildTargetIndex, OUTPUT_FILE as TARGET_INDEX_FILE } from './lib/target-index-builder.js';
import { writeFirstRunSentinel } from './lib/aggregated-sentinel.js';
import { AGGREGATED_FILES, ENRICHED_FILES } from './lib/aggregated-files.js';

const SCRIPT_DIR = 'scripts/factory';

function runScript(name) {
    // 4GB V8 heap headroom — PR 1.6c unified-stream defense (architect-locked 2026-05-25).
    return new Promise((resolve, reject) => {
        const child = spawn('node', ['--max-old-space-size=4096', path.join(SCRIPT_DIR, name)], {
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
        // Cycle 21 PR #113 (post-#112 hotfix): use ENRICHED_FILES SSoT, not
        // hardcoded 2-file list. PR #112 fixed stage-2 upload side to include
        // drug-labels.jsonl per ENRICHED_FILES, but stage-3 download side
        // kept the old 2-file hardcoded list, so drug-labels.jsonl was
        // downloaded-skipped → stage-3 enrichers ran without it → stage-3
        // uploadStage(AGGREGATED_FILES) HARDFAIL on missing drug-labels.jsonl
        // (uploadStage missing-check fired correctly per cycle 21 PR #4
        // [[feedback_cross_cycle_silent_data_loss]] defense). Same SSoT
        // for both sides of the boundary.
        await downloadStage('enriched', ENRICHED_FILES);
    } catch (err) {
        console.error(`[STAGE-3] Enriched download failed: ${err.message}`);
        process.exit(2);
    }

    // V0.5.x: trial scripts run sequentially — trial-linker + trial-results-enricher
    // both writeFile trials.jsonl (last-writer-wins) so trial-linker (slowest) would
    // overwrite enricher's serious_events_count, starving neg-evidence-builder of
    // serious_adverse_event_per_trial (cycle 1: 0 vs V0.4.3-local 161). ctis-trial-
    // linker appendFiles (safe) but ordered after trial-linker keeps base aligned.
    // Papers writes a different file; trial-group + paper-group run in parallel.
    // PR 1.4-pre.1b targets-linker + PR 1.6b-pre.1b disease-linker each own
    // disjoint output files so all four groups parallel-safe.
    const [trialResults, paperResults, targetResults, diseaseResults] = await Promise.all([
        runSequential('Trials', [
            { name: 'trial-linker', fn: () => runScript('trial-linker.js') },
            { name: 'ctis-trial-linker', fn: () => runScript('ctis-trial-linker.js') },
            { name: 'trial-results-enricher', fn: () => runScript('trial-results-enricher.js') },
        ]),
        runSequential('Papers', [
            { name: 'paper-linker', fn: () => runScript('paper-linker.js') },
        ]),
        runSequential('Targets', [
            { name: 'target-linker', fn: () => runScript('target-linker.js') },
        ]),
        runSequential('Diseases', [
            { name: 'disease-linker', fn: () => runScript('disease-linker.js') },
        ]),
    ]);

    const crossLinkResults = await runSequential('Cross-link + Negative Evidence', [
        { name: 'bidirectional-linker', fn: () => runScript('bidirectional-linker.js') },
        { name: 'neg-evidence-builder', fn: () => runScript('neg-evidence-builder.js') },
    ]);

    // V0.5.2.1 cumulative aggregation extracted to lib/stage-3-merge.js
    // (cycle 22 PR-CORE-3 split for Art 5.1). Hard-fails via process.exit
    // on the suspicious-prior-state cases (codes 4/5/6/7); see helper
    // module header for the full code table.
    await executeCumulativeMerge(runId);

    // PR-CORE-3 (cycle 22): aggregated cumulative backfill. Runs AFTER the
    // cumulative merge (so we operate on the post-merge cumulative) and
    // BEFORE the search/target indices (so they reflect newly-backfilled
    // records). Closes the wiring arc that PR-CORE-2 missed (its F2-side
    // cursors only see ~5k F1 deltas, never the ~70k cumulative backlog).
    // Per D7: non-fatal to F3 - failure logs explicit but stage continues
    // with un-backfilled cumulative so the un-related downstream work
    // (search index, target index, upload, snapshot) still produces output.
    console.log('\n[STAGE-3] === PR-CORE-3 cumulative backfill ===');
    try {
        await runScript('aggregated-backfill-enrich.js');
        console.log('[STAGE-3] Backfill OK');
    } catch (err) {
        console.error(`[STAGE-3] Backfill failed (non-fatal, F3 continues with un-backfilled cumulative): ${err.message}`);
    }

    // PR-OT-4 (cycle 23): Open Targets bulk merge into compound entity.
    // Reads OT bulk artifact from R2 (per [[project_cycle23_pr_ot_1_shipped]])
    // and folds known_drug_info + target_associations into chembl_id-bearing
    // compounds. Closes the researcher-experience gap where OT data sat in
    // R2 staging but did not surface at the API compound entity (per
    // [[researcher_needs_anchor]] 2026-05-24 decision). Non-fatal: OT-merge
    // failure leaves compounds-enriched.jsonl in un-OT-enriched state but
    // does not block search/target indices or R2 upload (researchers degrade
    // gracefully; OT data resurfaces on the next successful run).
    console.log('\n[STAGE-3] === PR-OT-4 Open Targets stage-3 merge ===');
    try {
        await runScript('open-targets-stage3-merge.js');
        console.log('[STAGE-3] OT merge OK');
    } catch (err) {
        console.error(`[STAGE-3] OT merge failed (non-fatal, F3 continues with un-OT-enriched compounds): ${err.message}`);
    }

    // PR-SID-1.1c..1.5 (cycle 23): SID stamping per V1.0 §35 — HARD-FAIL on any failure.
    console.log('\n[STAGE-3] === PR-SID-1.1c compound stamping ===');
    await runScript('stage-3-sid-stamp.js');
    console.log('\n[STAGE-3] === PR-SID-1.2 trial stamping ===');
    await runScript('stage-3-trial-sid-stamp.js');
    console.log('\n[STAGE-3] === PR-SID-1.3 paper stamping ===');
    await runScript('stage-3-paper-sid-stamp.js');
    console.log('\n[STAGE-3] === PR-SID-1.4 target stamping ===');
    await runScript('stage-3-target-sid-stamp.js');
    console.log('\n[STAGE-3] === PR-SID-1.5 bioactivity stamping ===');
    await runScript('stage-3-bioactivity-sid-stamp.js');
    console.log('\n[STAGE-3] === PR-SID-1.6b disease stamping ===');
    await runScript('stage-3-disease-sid-stamp.js');
    console.log('\n[STAGE-3] === PR-SID-1.6a SAL stamping (bioactivity-as-assertion) ===');
    await runScript('stage-3-sal-sid-stamp.js');

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
        + diseaseResults.filter(r => !r.ok).length
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
