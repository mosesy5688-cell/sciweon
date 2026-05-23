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
 *   processed/enriched/<run_id>/<ENRICHED_FILES list>      (SSoT in
 *     lib/aggregated-files.js — currently compounds-enriched.jsonl +
 *     bioactivities.jsonl + drug-labels.jsonl. Drift between this list
 *     and the actual emit pipeline is what silently dropped drug-labels
 *     from cycle 21 PRs #103-#8; SSoT extraction 2026-05-23 closes the
 *     pattern for stage-2 as PR #98 did for stage-3/4.)
 *   processed/enriched/latest.json
 *
 * Exit codes:
 *   0  all enrichers succeeded (each produced non-zero records)
 *   1  some enrichers failed (degraded - uploaded what completed)
 *   2  baseline download failed (no input)
 *   3  R2 upload failed
 */

import { spawn } from 'child_process';
import path from 'path';
import { downloadStage, uploadStage, deriveRunId } from './lib/r2-stage-bridge.js';
import { downloadAdapterCumulative } from './lib/adapter-bridge.js';
import { countJsonlRecords } from './lib/snapshot-history-gate.js';
import { decideYieldAction } from './lib/stage-2-yield.js';
import { downloadCache, uploadCache } from './lib/r2-cache-bridge.js';
import { ENRICHED_FILES } from './lib/aggregated-files.js';

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

async function runSequential(label, tasks, yieldFile) {
    console.log(`\n[STAGE-2] === ${label} (sequential, ${tasks.length} steps) ===`);
    const summaries = [];
    let prev = yieldFile ? (await countJsonlRecords(yieldFile).catch(() => 0)) : null;
    if (yieldFile) console.log(`[STAGE-2] ${label} baseline ${yieldFile}: ${prev} records`);

    for (const t of tasks) {
        try {
            await t.fn();

            let yieldInfo = '';
            let recordsAfter = prev;
            if (yieldFile) {
                const now = await countJsonlRecords(yieldFile).catch(() => 0);
                const delta = now - prev;
                yieldInfo = ` · ${now} records (${delta >= 0 ? '+' : ''}${delta})`;
                const decision = decideYieldAction({
                    currentRecords: now,
                    taskName: t.name,
                    yieldFile,
                });
                if (decision.kind === 'zero_records_abort') {
                    throw new Error(decision.message);
                }
                prev = now;
                recordsAfter = now;
            }

            console.log(`[STAGE-2] ${label}/${t.name} OK${yieldInfo}`);
            summaries.push({ task: t.name, ok: true, error: null, records: recordsAfter });
        } catch (err) {
            // V0.5.x policy (2026-05-15): any sub-script failure halts the stage
            // IMMEDIATELY. Do NOT continue and do NOT let `uploadStage` run on
            // partial data — bad data must never pollute production R2.
            // V0.5.6 (2026-05-19): also treats 0-records yield as failure
            // ([[feedback_cross_cycle_silent_data_loss]] Pattern A 3rd closure).
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

    console.log('\n[STAGE-2] === Download adapter cumulative from R2 (optional) ===');
    try {
        const got = await downloadAdapterCumulative();
        if (!got) console.log('[STAGE-2] No adapter cumulative yet — adapter-cross-linker will no-op');
    } catch (err) {
        console.warn(`[STAGE-2] Adapter cumulative download failed (non-fatal): ${err.message}`);
    }

    console.log('\n[STAGE-2] === Download chembl negative cache (optional) ===');
    try {
        await downloadCache('chembl-negative-cache.json');
    } catch (err) {
        console.warn(`[STAGE-2] Cache download failed (non-fatal, will rebuild): ${err.message}`);
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
        // chembl-compound-enricher must run before compound-id-resolver so that
        // drug_status is available; and before fda/faers which gate on UNII.
        { name: 'chembl-compound', fn: () => runScript('chembl-compound-enricher.js') },
        { name: 'compound-id-resolver', fn: () => runScript('compound-id-resolver.js') },
        { name: 'adapter-cross-linker', fn: () => runScript('adapter-cross-linker.js') },
        { name: 'fda', fn: () => runScript('fda-enricher.js') },
        { name: 'compound-faers', fn: () => runScript('compound-faers-enricher.js') },
    ], './output/linked/compounds-enriched.jsonl');
    const idResolverOk = compoundResults.find(r => r.task === 'compound-id-resolver')?.ok ?? false;

    // V0.5.x: bioactivity enrichers also serialised — both modify bioactivities.jsonl.
    const bioactivityResults = await runSequential('Bioactivity Enrichers', [
        { name: 'target-resolver', fn: () => runScript('target-resolver.js') },
        { name: 'bioactivity-cross-validator', fn: () => runScript('bioactivity-cross-validator.js') },
    ], './output/linked/bioactivities.jsonl');

    console.log('\n[STAGE-2] === Upload chembl negative cache ===');
    try {
        await uploadCache('chembl-negative-cache.json');
    } catch (err) {
        console.warn(`[STAGE-2] Cache upload failed (non-fatal, will rebuild next run): ${err.message}`);
    }

    console.log('\n[STAGE-2] === Upload enriched bundle to R2 ===');
    try {
        await uploadStage('enriched', runId, ENRICHED_FILES);
    } catch (err) {
        console.error(`[STAGE-2] R2 upload failed: ${err.message}`);
        process.exit(3);
    }

    const failureCount = compoundResults.filter(r => !r.ok).length
        + bioactivityResults.filter(r => !r.ok).length;

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STAGE-2] === Summary ===`);
    console.log(`  Elapsed:        ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  Compound enrichers OK: ${compoundResults.filter(r => r.ok).length}/${compoundResults.length}`);
    console.log(`  ID resolver:    ${idResolverOk ? 'OK' : 'FAIL'}`);
    console.log(`  Bioactivity OK: ${bioactivityResults.filter(r => r.ok).length}/${bioactivityResults.length}`);
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
