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
import { enforceCompletenessInvariant } from './lib/aggregated-invariant.js';
import { runSidStampingCascade } from './lib/stage-3-stampers.js';
import { makeR2Client } from './lib/sid-stage3-shared.js';
import { isSnomedColdStart, warnSnomedColdStart } from './lib/snomed-cold-start.js';
import { isLoincColdStart, warnLoincColdStart } from './lib/loinc-cold-start.js';

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
        // Cycle 21 PR #113: use ENRICHED_FILES SSoT (not a hardcoded 2-file list)
        // for BOTH sides of the enriched boundary so drug-labels.jsonl is never
        // download-skipped (which previously hard-failed uploadStage downstream).
        await downloadStage('enriched', ENRICHED_FILES);
    } catch (err) {
        console.error(`[STAGE-3] Enriched download failed: ${err.message}`);
        process.exit(2);
    }

    // PR-UMLS-3 cold-start guard (see lib/snomed-cold-start.js for both invariants): determine
    // SNOMED cold-start ONCE via a single R2 HEAD on the bulk cursor. cursor ABSENT (404) -> skip
    // the WHOLE SNOMED sub-pipeline gracefully (Invariant 1, snapshot still ships); cursor PRESENT
    // + broken artifact -> each stage HARD-FAILS in place (Invariant 2). Threads to linker + cascade.
    const snomedColdStart = await isSnomedColdStart({ client: makeR2Client('STAGE-3'), bucket: process.env.R2_BUCKET });
    if (snomedColdStart) warnSnomedColdStart();

    // PR-UMLS-4 cold-start guard (see lib/loinc-cold-start.js): same single-R2-HEAD discriminator
    // on the LOINC bulk cursor, independent of SNOMED. Threads to the linker + cascade identically.
    const loincColdStart = await isLoincColdStart({ client: makeR2Client('STAGE-3'), bucket: process.env.R2_BUCKET });
    if (loincColdStart) warnLoincColdStart();

    // V0.5.x: trials run sequentially (last-writer-wins on trials.jsonl); papers/targets/
    // diseases/mesh each own disjoint output files so parallel-safe (PR-UMLS-2 mesh too).
    const [trialResults, paperResults, targetResults, diseaseResults, meshResults, snomedResults, loincResults] = await Promise.all([
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
            // PR-UNIPROT-2b: enrich targets.jsonl by UniProt accession (all-organism). SEQUENTIAL after target-linker -- same output/linked/targets.jsonl.
            { name: 'uniprot-target-enrich', fn: () => runScript('uniprot-target-enrich.js') },
        ]),
        runSequential('Diseases', [
            { name: 'disease-linker', fn: () => runScript('disease-linker.js') },
        ]),
        runSequential('MeSH', [{ name: 'mesh-concept-linker', fn: () => runScript('mesh-concept-linker.js') }]),
        // PR-UMLS-3: snomed-concept-linker owns snomed-concepts.jsonl (disjoint) -> parallel-safe.
        // Cold-start guard: skipped (no R2 cursor) so the linker's no-catch cursor read can never throw + meltdown the daily cascade before the first SNOMED harvest materializes.
        snomedColdStart
            ? Promise.resolve([{ task: 'snomed-concept-linker', ok: true, error: null, skipped: 'snomed-cold-start' }])
            : runSequential('SNOMED', [{ name: 'snomed-concept-linker', fn: () => runScript('snomed-concept-linker.js') }]),
        // PR-UMLS-4: loinc-concept-linker owns loinc-concepts.jsonl (disjoint) -> parallel-safe.
        // Cold-start guard: skipped (no R2 cursor) so the linker's no-catch cursor read can never
        // throw and meltdown the daily cascade before the first LOINC harvest materializes.
        loincColdStart
            ? Promise.resolve([{ task: 'loinc-concept-linker', ok: true, error: null, skipped: 'loinc-cold-start' }])
            : runSequential('LOINC', [{ name: 'loinc-concept-linker', fn: () => runScript('loinc-concept-linker.js') }]),
    ]);

    const crossLinkResults = await runSequential('Cross-link + Negative Evidence', [
        { name: 'bidirectional-linker', fn: () => runScript('bidirectional-linker.js') },
        { name: 'neg-evidence-builder', fn: () => runScript('neg-evidence-builder.js') },
    ]);

    // V0.5.2.1 cumulative aggregation extracted to lib/stage-3-merge.js (cycle 22 PR-CORE-3
    // split for Art 5.1). Hard-fails via process.exit on the suspicious-prior-state cases
    // (codes 4/5/6/7); see the helper module header for the full code table.
    await executeCumulativeMerge(runId);

    // PR-CORE-3 (cycle 22): aggregated cumulative backfill, AFTER the merge and BEFORE the
    // indices (so they reflect backfilled records). Closes the wiring arc PR-CORE-2 missed.
    // Per D7: non-fatal to F3 - failure logs but the stage still ships downstream output.
    console.log('\n[STAGE-3] === PR-CORE-3 cumulative backfill ===');
    try {
        await runScript('aggregated-backfill-enrich.js');
        console.log('[STAGE-3] Backfill OK');
    } catch (err) {
        console.error(`[STAGE-3] Backfill failed (non-fatal, F3 continues with un-backfilled cumulative): ${err.message}`);
    }

    // PR-OT-4 (cycle 23): Open Targets bulk merge into compound entity. Reads the OT bulk
    // artifact from R2 and folds known_drug_info + target_associations into chembl_id-bearing
    // compounds (per [[researcher_needs_anchor]] 2026-05-24). Non-fatal: OT-merge failure leaves
    // compounds un-OT-enriched but does not block indices or R2 upload (resurfaces next run).
    console.log('\n[STAGE-3] === PR-OT-4 Open Targets stage-3 merge ===');
    try {
        await runScript('open-targets-stage3-merge.js');
        console.log('[STAGE-3] OT merge OK');
    } catch (err) {
        console.error(`[STAGE-3] OT merge failed (non-fatal, F3 continues with un-OT-enriched compounds): ${err.message}`);
    }

    // PR-SID-1.1c..1.10 (cycle 23 + UMLS): SID stamping cascade (HARD-FAIL) + the post-stamp
    // UMLS phases (MeSH/SNOMED/LOINC public projections + MeSH/SNOMED cross-link enrichers).
    // Extracted to lib/stage-3-stampers.js for Art 5.1. Cold-start guard (Invariant 1): when
    // snomedColdStart / loincColdStart, that vocabulary's cascade entries are excluded while the
    // rest still run; the snapshot ships without the cold vocabulary. (LOINC crosslink = PR-4b.)
    await runSidStampingCascade(runScript, { skipSnomed: snomedColdStart, skipLoinc: loincColdStart });

    // V0.5.3 Tier 1.5 search index — rebuild SQLite FTS5 over cumulative aggregated, AFTER the
    // merge so it reflects historical + current compounds. Non-fatal: search endpoint falls
    // back to ID lookup rather than halting the chain (search is enhancement, not lifeline).
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

    // C2-3 target inverse-pivot index. Non-fatal: /api/v1/target/* 404s if absent, rest ships.
    console.log('\n[STAGE-3] === Build target inverse-pivot index ===');
    try {
        const s = await buildTargetIndex({ outputPath: path.join('./output/linked', TARGET_INDEX_FILE) });
        console.log(`[STAGE-3] Target index: ${s.targetCount} targets, ${s.bioactivitiesIndexed} bioacts, ${s.trialEdges} trial edges, ${s.negEvidenceEdges} neg edges, ${(s.sizeBytes / 1024 / 1024).toFixed(2)} MB in ${s.elapsedSec}s`);
    } catch (err) {
        console.error(`[STAGE-3] Target index build failed (non-fatal): ${err.message}`);
    }

    // PR-CORE-MERGE-LEAK pre-upload invariant guard (hard-fails on unichem regression).
    console.log('\n[STAGE-3] === Pre-upload invariant guard ===');
    await enforceCompletenessInvariant({ localCompoundsPath: path.join('./output/linked', 'compounds-enriched.jsonl'), runId, label: '[STAGE-3 INVARIANT]' });

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
