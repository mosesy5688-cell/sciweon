/**
 * Stage 1/4 — Harvest (V0.5.1)
 *
 * Reads cursor from R2, drains the persistent retry queue, harvests next CID
 * range from PubChem, links across ChEMBL (cross-source-linker), uploads raw
 * + processed baseline to R2, then updates retry queue + advances cursor.
 *
 * Retry queue (V0.5.1):
 *   Transient PubChem fetch failures (HTTP 5xx / network / timeout) are no
 *   longer silently dropped. Each failed CID is recorded in
 *   R2:state/harvest-retry-queue.json and re-attempted by the next run's
 *   pass-1 drain. Queue depth is capped at 500 — exceeding the cap halts
 *   the chain (real PubChem outage rather than transient blips).
 *
 * Outputs:
 *   R2 raw/pubchem/incremental/<run_id>/compounds-cid-N-M.jsonl
 *   R2 processed/baseline/<run_id>/compounds-enriched.jsonl
 *   R2 processed/baseline/<run_id>/bioactivities.jsonl
 *   R2 processed/baseline/latest.json  (pointer for stage 2)
 *   R2 state/harvest-cursor.json       (advanced on success)
 *   R2 state/harvest-retry-queue.json  (merged on success)
 *
 * Exit codes:
 *   0  success - cursor advanced, queue updated, stage 2 can run
 *   1  partial failure - cursor unchanged, queue unchanged
 *   2  pubchem-harvester failed (gate) - aborted before linking
 *   3  cross-source-linker failed - raw uploaded but baseline missing
 *   4  R2 upload or queue write failed - cursor not advanced
 *   5  retry queue exceeded MAX_QUEUE_DEPTH (real upstream outage)
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { readCursor, writeCursor } from './lib/harvest-cursor.js';
import {
    readQueue, writeQueue, mergeFailures, pruneExhausted, MAX_QUEUE_DEPTH,
} from './lib/harvest-retry-queue.js';
import { uploadStage, uploadRaw, deriveRunId, verifyNonEmpty } from './lib/r2-stage-bridge.js';
import { writeHarvestHistory } from './lib/harvest-history.js';

const LIMIT_PER_RUN = parseInt(process.env.HARVEST_LIMIT || '5000');
const MANUAL_START_CID = parseInt(process.env.MANUAL_START_CID || '0');
const RETRY_CIDS_PER_RUN = parseInt(process.env.RETRY_CIDS_PER_RUN || '200');
const SCRIPT_DIR = 'scripts/factory';

function runScript(name, args = [], extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPT_DIR, name);
        const child = spawn('node', [scriptPath, ...args], {
            stdio: 'inherit',
            env: { ...process.env, ...extraEnv },
        });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${name} exit code ${code}`));
        });
        child.on('error', err => reject(err));
    });
}

function runPythonScript(name, args = []) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPT_DIR, name);
        const py = process.env.PYTHON || 'python';
        const child = spawn(py, [scriptPath, ...args], {
            stdio: 'inherit',
            env: process.env,
        });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`python ${name} exit code ${code}`));
        });
        child.on('error', err => reject(err));
    });
}

async function readHarvestManifest(startCid, endCid) {
    const file = path.join('./output/compounds', `harvest-manifest-${startCid}-${endCid}.json`);
    try {
        const buf = await fs.readFile(file, 'utf-8');
        return JSON.parse(buf);
    } catch (err) {
        throw new Error(`Failed to read harvest manifest at ${file}: ${err.message}`);
    }
}

async function main() {
    const startTime = Date.now();
    const runId = deriveRunId();
    console.log(`[STAGE-1] Sciweon Factory Harvest V0.5.1 run_id=${runId}`);

    const cursor = await readCursor();
    const startCid = MANUAL_START_CID > 0 ? MANUAL_START_CID : cursor.next_cid;
    const endCid = startCid + LIMIT_PER_RUN - 1;
    console.log(`[STAGE-1] Cursor: next_cid=${cursor.next_cid}, total_collected=${cursor.total_collected}`);
    console.log(`[STAGE-1] This run: CID ${startCid} to ${endCid} (limit=${LIMIT_PER_RUN})`);

    const queueBefore = await readQueue();
    const retryBatch = queueBefore.entries.slice(0, RETRY_CIDS_PER_RUN).map(e => e.cid);
    console.log(`[STAGE-1] Retry queue: depth=${queueBefore.entries.length}, draining=${retryBatch.length} this run`);

    console.log('\n[STAGE-1] === pubchem-harvester (gate) ===');
    try {
        await runScript(
            'pubchem-harvester.js',
            [`--start-cid=${startCid}`, `--limit=${LIMIT_PER_RUN}`],
            { RETRY_CIDS: retryBatch.join(',') },
        );
    } catch (err) {
        console.error(`[STAGE-1] pubchem-harvester failed: ${err.message}`);
        process.exit(2);
    }

    const rawFile = `./output/compounds/compounds-cid-${startCid}-${endCid}.jsonl`;
    try {
        await verifyNonEmpty(rawFile);
    } catch (err) {
        console.error(`[STAGE-1] Raw harvest output missing or empty: ${err.message}`);
        process.exit(2);
    }

    const manifest = await readHarvestManifest(startCid, endCid);

    // C1-4 fix (PR #90): descriptor-precompute runs BEFORE cross-source-linker,
    // not after stage-1-harvest as the original workflow step did. cross-source-linker
    // is passthrough — it mutates compounds in-place and writes the same objects to
    // the baseline file. If descriptors are in rawFile, they flow through to baseline
    // and uploadStage carries them to R2. Running descriptor AFTER uploadStage (the
    // original V0.5.8 placement) put them in the rawFile too late — the baseline
    // had already been uploaded without them.
    console.log('\n[STAGE-1] === descriptor-precompute (QED + AromaticRings + StructuralAlerts) ===');
    try {
        await runPythonScript('descriptor-precompute.py', [`--dir=./output/compounds`]);
    } catch (err) {
        console.error(`[STAGE-1] descriptor-precompute failed: ${err.message}`);
        // Hard fail — per [[feedback_cross_cycle_silent_data_loss]], silent skip is forbidden.
        // If Python/RDKit broke, refuse to continue (would silently drop descriptors).
        process.exit(7);
    }

    console.log('\n[STAGE-1] === cross-source-linker (raw -> linked baseline) ===');
    try {
        await runScript('cross-source-linker.js', [`--input=${rawFile}`, `--limit=${LIMIT_PER_RUN}`]);
    } catch (err) {
        console.error(`[STAGE-1] cross-source-linker failed: ${err.message}`);
        try {
            await uploadRaw('pubchem/incremental', runId, [
                [rawFile, path.basename(rawFile)],
            ]);
            console.log('[STAGE-1] Raw uploaded for diagnostic; cursor NOT advanced, queue NOT updated');
        } catch (uploadErr) {
            console.error(`[STAGE-1] Even raw upload failed: ${uploadErr.message}`);
        }
        process.exit(3);
    }

    const baselineFiles = ['compounds-enriched.jsonl', 'bioactivities.jsonl'];
    for (const f of baselineFiles) {
        try {
            await verifyNonEmpty(path.join('./output/linked', f));
        } catch (err) {
            console.error(`[STAGE-1] Baseline output check failed: ${err.message}`);
            process.exit(3);
        }
    }

    console.log('\n[STAGE-1] === Upload raw + baseline to R2 ===');
    try {
        await uploadRaw('pubchem/incremental', runId, [
            [rawFile, path.basename(rawFile)],
        ]);
        await uploadStage('baseline', runId, baselineFiles);
    } catch (err) {
        console.error(`[STAGE-1] R2 upload failed: ${err.message}`);
        process.exit(4);
    }

    // Harvest history is observability, not critical path — best-effort only.
    // Failure here must NOT crash stage-1 (cursor still advances, baseline
    // already in R2). source-health.yml will read these summaries to detect
    // sustained WARN signal across consecutive cycles.
    try {
        await writeHarvestHistory({ runId, manifest, startCid, endCid });
    } catch (err) {
        console.warn(`[STAGE-1] Harvest history write failed (non-fatal): ${err.message}`);
    }

    console.log('\n[STAGE-1] === Update retry queue ===');
    let queueAfterMerge;
    try {
        const merged = mergeFailures(queueBefore, manifest.failed_fetches || [], manifest.retry_successes || []);
        const { active, exhausted } = pruneExhausted(merged);
        if (exhausted.length > 0) {
            console.warn(`[STAGE-1] Purged ${exhausted.length} exhausted CIDs (>=10 retries, likely deprecated): ${exhausted.map(e => e.cid).join(',')}`);
        }
        queueAfterMerge = active;
        if (queueAfterMerge.entries.length > MAX_QUEUE_DEPTH) {
            console.error(`[STAGE-1] Retry queue depth ${queueAfterMerge.entries.length} exceeds cap ${MAX_QUEUE_DEPTH} - likely PubChem outage. Halting before cursor advance.`);
            process.exit(5);
        }
        await writeQueue(queueAfterMerge);
    } catch (err) {
        console.error(`[STAGE-1] Retry queue update failed: ${err.message}`);
        process.exit(4);
    }

    console.log('\n[STAGE-1] === Advance cursor ===');
    try {
        await writeCursor({
            next_cid: endCid + 1,
            last_run_at: new Date().toISOString(),
            last_success_count: manifest.stats.valid,
            total_collected: cursor.total_collected + manifest.stats.valid,
        });
    } catch (err) {
        console.error(`[STAGE-1] Cursor write failed: ${err.message} (data is in R2, but next run retries same range)`);
        process.exit(4);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STAGE-1] === Summary ===`);
    console.log(`  Elapsed:           ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  CID range:         ${startCid} to ${endCid}`);
    console.log(`  Cursor advance:    ${cursor.next_cid} -> ${endCid + 1}`);
    console.log(`  Harvest stats:     ${manifest.stats.attempted} attempted | ${manifest.stats.fetched} fetched | ${manifest.stats.valid} valid | ${manifest.stats.warned} warned`);
    console.log(`  Retry pass:        ${(manifest.retry_successes || []).length} recovered | ${(manifest.retry_failures || []).length} failed again`);
    console.log(`  New fetch failures: ${(manifest.failed_fetches || []).length}`);
    console.log(`  Retry queue:       ${queueBefore.entries.length} in -> ${queueAfterMerge.entries.length} out (cap ${MAX_QUEUE_DEPTH})`);
    console.log(`  R2 run prefix:     processed/baseline/${runId}/`);
    console.log('[STAGE-1] Stage 2 will pick up via workflow_run trigger');
    process.exit(0);
}

main().catch(err => {
    console.error('[STAGE-1] Fatal:', err.message);
    process.exit(1);
});
