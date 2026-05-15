/**
 * Stage 2/4 — Process (V0.5.x refactor)
 *
 * Reads baseline (compounds-enriched.jsonl + bioactivities.jsonl) from R2,
 * runs compound enrichers + bioactivity enrichers in parallel where safe,
 * uploads enriched bundle to R2 processed/enriched/<run_id>/.
 *
 * Inputs (R2):
 *   processed/baseline/<latest_pointer>/compounds-enriched.jsonl
 *   processed/baseline/<latest_pointer>/bioactivities.jsonl
 *
 * Outputs (R2):
 *   processed/enriched/<run_id>/compounds-enriched.jsonl  (in-place enriched)
 *   processed/enriched/<run_id>/bioactivities.jsonl       (cross-validated)
 *   processed/enriched/latest.json
 *
 * Exit codes:
 *   0  all 6 scripts succeeded
 *   1  some enrichers failed (degraded - uploaded what completed)
 *   2  baseline download failed (no input)
 *   3  R2 upload failed
 */

import { spawn } from 'child_process';
import path from 'path';
import { downloadStage, uploadStage, deriveRunId } from './lib/r2-stage-bridge.js';

const SCRIPT_DIR = 'scripts/factory';

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

async function runParallel(label, tasks) {
    console.log(`\n[STAGE-2] === ${label} (${tasks.length}-way parallel) ===`);
    const settled = await Promise.allSettled(tasks.map(t => t.fn()));
    const summaries = settled.map((r, i) => ({
        task: tasks[i].name,
        ok: r.status === 'fulfilled',
        error: r.status === 'rejected' ? r.reason?.message : null,
    }));
    const failed = summaries.filter(s => !s.ok);
    if (failed.length > 0) {
        console.warn(`[STAGE-2] ${label}: ${failed.length}/${tasks.length} failed`);
        for (const f of failed) console.warn(`  - ${f.task}: ${f.error}`);
    } else {
        console.log(`[STAGE-2] ${label}: all ${tasks.length} OK`);
    }
    return summaries;
}

async function runSequential(label, tasks) {
    console.log(`\n[STAGE-2] === ${label} (sequential, ${tasks.length} steps) ===`);
    const summaries = [];
    for (const t of tasks) {
        try {
            await t.fn();
            summaries.push({ task: t.name, ok: true, error: null });
        } catch (err) {
            // V0.5.x policy (2026-05-15): any sub-script failure halts the stage
            // IMMEDIATELY. Do NOT continue and do NOT let `uploadStage` run on
            // partial data — bad data must never pollute production R2.
            console.error(`[STAGE-2] ${label}/${t.name} failed: ${err.message}`);
            summaries.push({ task: t.name, ok: false, error: err.message });
            throw new Error(`[STAGE-2] ${label}/${t.name} failed — stage aborted before R2 upload to prevent pollution. Original error: ${err.message}`);
        }
    }
    return summaries;
}

async function main() {
    const startTime = Date.now();
    const runId = deriveRunId();
    console.log(`[STAGE-2] Sciweon Factory Process V0.5.x run_id=${runId}`);

    console.log('\n[STAGE-2] === Download baseline from R2 ===');
    try {
        await downloadStage('baseline', ['compounds-enriched.jsonl', 'bioactivities.jsonl']);
    } catch (err) {
        console.error(`[STAGE-2] Baseline download failed: ${err.message}`);
        process.exit(2);
    }

    // V0.5.x: compound enrichers all run sequentially.
    // Same-file race: every enricher loads compounds-enriched.jsonl, modifies, writes
    // back — concurrent writers overwrite each other (last writer wins). Previously
    // parallel block lost fingerprint/KEGG data + ran fda/faers before id-resolver
    // populated external_ids.unii, so no fda_signals -> 0 black_box_warning and
    // 0 faers_adr_signal NegEvidence records in cycle 1 (R2 2026-05-15 audit).
    // Order matters: id-resolver populates UNII; fda-enricher requires UNII and
    // sets fda_signals; compound-faers-enricher requires UNII and extends fda_signals.
    const compoundResults = await runSequential('Compound Enrichers', [
        { name: 'fingerprint', fn: () => runScript('compound-fingerprint-enricher.js') },
        { name: 'kegg', fn: () => runScript('compound-kegg-enricher.js') },
        { name: 'compound-id-resolver', fn: () => runScript('compound-id-resolver.js') },
        { name: 'fda', fn: () => runScript('fda-enricher.js') },
        { name: 'compound-faers', fn: () => runScript('compound-faers-enricher.js') },
    ]);
    const idResolverOk = compoundResults.find(r => r.task === 'compound-id-resolver')?.ok ?? false;

    // V0.5.x: bioactivity enrichers also serialised — both modify bioactivities.jsonl.
    const bioactivityResults = await runSequential('Bioactivity Enrichers', [
        { name: 'target-resolver', fn: () => runScript('target-resolver.js') },
        { name: 'bioactivity-cross-validator', fn: () => runScript('bioactivity-cross-validator.js') },
    ]);

    console.log('\n[STAGE-2] === Upload enriched bundle to R2 ===');
    try {
        await uploadStage('enriched', runId, ['compounds-enriched.jsonl', 'bioactivities.jsonl']);
    } catch (err) {
        console.error(`[STAGE-2] R2 upload failed: ${err.message}`);
        process.exit(3);
    }

    const failureCount = compoundResults.filter(r => !r.ok).length
        + bioactivityResults.filter(r => !r.ok).length;

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STAGE-2] === Summary ===`);
    console.log(`  Elapsed:        ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  Compound enrichers OK: ${compoundResults.filter(r => r.ok).length}/5`);
    console.log(`  ID resolver:    ${idResolverOk ? 'OK' : 'FAIL'}`);
    console.log(`  Bioactivity OK: ${bioactivityResults.filter(r => r.ok).length}/2`);
    console.log(`  R2 run prefix:  processed/enriched/${runId}/`);

    if (failureCount > 0) {
        console.warn('[STAGE-2] Completed with degraded enrichment');
        process.exit(1);
    }
    console.log('[STAGE-2] All enrichers OK, stage 3 will pick up');
    process.exit(0);
}

main().catch(err => {
    console.error('[STAGE-2] Fatal:', err.message);
    process.exit(1);
});
