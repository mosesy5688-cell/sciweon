/**
 * Factory Harvest Orchestrator V0.5.0 (Stage 1)
 *
 * 8-phase pipeline coordinator. Reads R2 cursor to determine the next
 * CID range, dispatches each pipeline phase, then advances the cursor
 * only after the final snapshot uploads successfully.
 *
 * Phases (per V0.5.0 design lock 2026-05-14):
 *   A  Harvest                 pubchem-harvester (gate)
 *   B  Compound ID             compound-id-resolver
 *   C  Compound Enrichers      fingerprint + kegg + faers + fda (4-way parallel)
 *   D  Bioactivity             target-resolver + bioactivity-cross-validator (parallel)
 *   E  Trials                  trial-linker + ctis-trial-linker + trial-results-enricher (parallel)
 *   F  Papers                  paper-linker (internal OpenAlex + S2 + PubMed)
 *   G  Cross-link              bidirectional-linker + cross-source-linker + neg-evidence-builder (seq)
 *   H  Validate + Snapshot     validation-gate + snapshot-builder + snapshot-uploader (seq)
 *
 * Parallelism: D, E, F run in parallel after C (no cross-deps). Within
 * each phase, parallel-safe tasks use Promise.allSettled so one adapter
 * failure does not block siblings.
 *
 * Cursor advance rule: only when Phase A succeeded AND Phase H's
 * snapshot-uploader succeeded. Any other failure leaves cursor frozen
 * so the next run retries the same CID range (idempotent).
 *
 * Exit codes:
 *   0  every phase OK
 *   1  Phase A OK, Phase B-H had degraded results (continued anyway)
 *   2  Phase A failed (no compound data, aborted)
 *   3  orchestrator script error
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { readCursor, writeCursor } from './lib/harvest-cursor.js';

const LIMIT_PER_RUN = parseInt(process.env.HARVEST_LIMIT || '5000');
const MANUAL_START_CID = parseInt(process.env.MANUAL_START_CID || '0');
const SCRIPT_DIR = 'scripts/factory';
const RESULT_FILE = 'output/orchestrator-result.json';

function runScript(name, args = []) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPT_DIR, name);
        const child = spawn('node', [scriptPath, ...args], {
            stdio: 'inherit',
            env: { ...process.env },
        });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`exit code ${code}`));
        });
        child.on('error', err => reject(err));
    });
}

async function runPhaseParallel(label, tasks) {
    console.log(`\n[ORCH] === ${label} (${tasks.length}-way parallel) ===`);
    const settled = await Promise.allSettled(tasks.map(t => t.fn()));
    const summaries = settled.map((r, i) => ({
        task: tasks[i].name,
        ok: r.status === 'fulfilled',
        error: r.status === 'rejected' ? r.reason?.message : null,
    }));
    const failed = summaries.filter(s => !s.ok);
    if (failed.length > 0) {
        console.warn(`[ORCH] ${label}: ${failed.length}/${tasks.length} failed`);
        for (const f of failed) console.warn(`  - ${f.task}: ${f.error}`);
    } else {
        console.log(`[ORCH] ${label}: all ${tasks.length} OK`);
    }
    return summaries;
}

async function runPhaseSequential(label, tasks) {
    console.log(`\n[ORCH] === ${label} (sequential) ===`);
    const summaries = [];
    for (const t of tasks) {
        try {
            await t.fn();
            summaries.push({ task: t.name, ok: true, error: null });
        } catch (err) {
            summaries.push({ task: t.name, ok: false, error: err.message });
            console.warn(`[ORCH] ${label}/${t.name} failed: ${err.message}`);
        }
    }
    const failed = summaries.filter(s => !s.ok);
    if (failed.length === 0) console.log(`[ORCH] ${label}: all ${tasks.length} OK`);
    return summaries;
}

function countFailures(allResults) {
    let total = 0;
    for (const phase of Object.values(allResults)) {
        if (Array.isArray(phase)) total += phase.filter(s => !s.ok).length;
        else if (phase && !phase.ok) total++;
    }
    return total;
}

async function writeReport(allResults, startTime, cursorRange) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const summary = {
        run_at: new Date().toISOString(),
        elapsed_seconds: elapsed,
        cursor_range: cursorRange,
        limit_per_run: LIMIT_PER_RUN,
        phases: allResults,
        failure_count: countFailures(allResults),
    };
    await fs.mkdir(path.dirname(RESULT_FILE), { recursive: true });
    await fs.writeFile(RESULT_FILE, JSON.stringify(summary, null, 2));
    console.log(`\n[ORCH] Report written: ${RESULT_FILE}`);
    return summary;
}

async function main() {
    const startTime = Date.now();
    console.log('[ORCH] Sciweon Factory Harvest Orchestrator V0.5.0');

    const cursorAtStart = await readCursor();
    const startCid = MANUAL_START_CID > 0 ? MANUAL_START_CID : cursorAtStart.next_cid;
    const endCid = startCid + LIMIT_PER_RUN - 1;
    console.log(`[ORCH] Cursor: next_cid=${cursorAtStart.next_cid}, total_collected=${cursorAtStart.total_collected}`);
    console.log(`[ORCH] This run: CID ${startCid} to ${endCid} (limit=${LIMIT_PER_RUN})`);

    const allResults = {};

    // Phase A - gate
    console.log('\n[ORCH] === Phase A: Harvest (gate) ===');
    try {
        await runScript('pubchem-harvester.js', [`--start-cid=${startCid}`, `--limit=${LIMIT_PER_RUN}`]);
        allResults.phaseA = { ok: true, error: null };
    } catch (err) {
        allResults.phaseA = { ok: false, error: err.message };
        console.error('[ORCH] Phase A failed - aborting downstream phases');
        await writeReport(allResults, startTime, { start: cursorAtStart.next_cid, end: cursorAtStart.next_cid });
        process.exit(2);
    }

    // Phase B - compound ID (sequential, single task)
    allResults.phaseB = await runPhaseSequential('Phase B: Compound ID', [
        { name: 'compound-id-resolver', fn: () => runScript('compound-id-resolver.js') },
    ]);

    // Phase C - compound enrichers (4-way parallel)
    allResults.phaseC = await runPhaseParallel('Phase C: Compound Enrichers', [
        { name: 'fingerprint', fn: () => runScript('compound-fingerprint-enricher.js') },
        { name: 'kegg', fn: () => runScript('compound-kegg-enricher.js') },
        { name: 'faers', fn: () => runScript('compound-faers-enricher.js') },
        { name: 'fda', fn: () => runScript('fda-enricher.js') },
    ]);

    // Phases D, E, F - parallel between phases
    const [phaseD, phaseE, phaseF] = await Promise.all([
        runPhaseParallel('Phase D: Bioactivity', [
            { name: 'target-resolver', fn: () => runScript('target-resolver.js') },
            { name: 'bioactivity-cross-validator', fn: () => runScript('bioactivity-cross-validator.js') },
        ]),
        runPhaseParallel('Phase E: Trials', [
            { name: 'trial-linker', fn: () => runScript('trial-linker.js') },
            { name: 'ctis-trial-linker', fn: () => runScript('ctis-trial-linker.js') },
            { name: 'trial-results-enricher', fn: () => runScript('trial-results-enricher.js') },
        ]),
        runPhaseSequential('Phase F: Papers', [
            { name: 'paper-linker', fn: () => runScript('paper-linker.js') },
        ]),
    ]);
    allResults.phaseD = phaseD;
    allResults.phaseE = phaseE;
    allResults.phaseF = phaseF;

    // Phase G - cross-link (sequential)
    allResults.phaseG = await runPhaseSequential('Phase G: Cross-link + Negative Evidence', [
        { name: 'bidirectional-linker', fn: () => runScript('bidirectional-linker.js') },
        { name: 'cross-source-linker', fn: () => runScript('cross-source-linker.js') },
        { name: 'neg-evidence-builder', fn: () => runScript('neg-evidence-builder.js') },
    ]);

    // Phase H - validate + snapshot + upload (sequential)
    allResults.phaseH = await runPhaseSequential('Phase H: Validate + Snapshot + Upload', [
        { name: 'validation-gate', fn: () => runScript('validation-gate.js') },
        { name: 'snapshot-builder', fn: () => runScript('snapshot-builder.js') },
        { name: 'snapshot-uploader', fn: () => runScript('snapshot-uploader.js') },
    ]);

    // Determine if Phase H's snapshot upload succeeded
    const uploaderResult = allResults.phaseH.find(s => s.task === 'snapshot-uploader');
    const snapshotUploaded = uploaderResult?.ok === true;

    // Cursor advance: only if Phase A succeeded AND snapshot uploaded
    const cursorAtEnd = { ...cursorAtStart };
    if (allResults.phaseA.ok && snapshotUploaded) {
        cursorAtEnd.next_cid = endCid + 1;
        cursorAtEnd.last_run_at = new Date().toISOString();
        cursorAtEnd.last_success_count = LIMIT_PER_RUN;
        cursorAtEnd.total_collected = cursorAtStart.total_collected + LIMIT_PER_RUN;
        try {
            await writeCursor(cursorAtEnd);
            console.log(`[ORCH] Cursor advanced: ${cursorAtStart.next_cid} -> ${cursorAtEnd.next_cid}`);
        } catch (err) {
            console.warn(`[ORCH] Cursor write failed: ${err.message} (next run retries same range)`);
        }
    } else {
        console.warn('[ORCH] Cursor NOT advanced (Phase A or snapshot upload failed)');
    }

    const summary = await writeReport(allResults, startTime, {
        start: cursorAtStart.next_cid,
        end: cursorAtEnd.next_cid,
    });
    const failureCount = summary.failure_count;

    console.log('\n[ORCH] === Summary ===');
    console.log(`  Elapsed:        ${summary.elapsed_seconds}s (${Math.round(summary.elapsed_seconds / 60 * 10) / 10} min)`);
    console.log(`  Cursor advance: ${cursorAtStart.next_cid} -> ${cursorAtEnd.next_cid}`);
    console.log(`  Phase A:        ${allResults.phaseA.ok ? 'OK' : 'FAIL'}`);
    console.log(`  Total failures: ${failureCount} across all phases`);

    if (!allResults.phaseA.ok) process.exit(2);
    if (failureCount > 0) {
        console.warn('[ORCH] Completed with degraded results');
        process.exit(1);
    }
    console.log('[ORCH] All phases OK');
    process.exit(0);
}

main().catch(err => {
    console.error('[ORCH] Fatal:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(3);
});
