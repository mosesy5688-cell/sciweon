/**
 * Stage 1/4 — Harvest (V0.5.x refactor)
 *
 * Reads cursor from R2, harvests next CID range from PubChem, links across
 * ChEMBL (cross-source-linker), uploads raw + processed baseline to R2,
 * advances cursor only when raw + baseline are durable in R2.
 *
 * Outputs:
 *   R2 raw/pubchem/incremental/<run_id>/compounds-cid-N-M.jsonl
 *   R2 processed/baseline/<run_id>/compounds-enriched.jsonl
 *   R2 processed/baseline/<run_id>/bioactivities.jsonl
 *   R2 processed/baseline/latest.json  (pointer for stage 2)
 *   R2 state/harvest-cursor.json       (advanced on success)
 *
 * Exit codes:
 *   0  success - cursor advanced, stage 2 can run
 *   1  partial failure - cursor unchanged, no downstream trigger
 *   2  pubchem-harvester failed (gate) - aborted before linking
 *   3  cross-source-linker failed - raw uploaded but baseline missing
 *   4  R2 upload failed - data loss prevented, retry next cron
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { readCursor, writeCursor } from './lib/harvest-cursor.js';
import { uploadStage, uploadRaw, deriveRunId, verifyNonEmpty } from './lib/r2-stage-bridge.js';

const LIMIT_PER_RUN = parseInt(process.env.HARVEST_LIMIT || '5000');
const MANUAL_START_CID = parseInt(process.env.MANUAL_START_CID || '0');
const SCRIPT_DIR = 'scripts/factory';

function runScript(name, args = []) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPT_DIR, name);
        const child = spawn('node', [scriptPath, ...args], {
            stdio: 'inherit',
            env: { ...process.env },
        });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${name} exit code ${code}`));
        });
        child.on('error', err => reject(err));
    });
}

async function main() {
    const startTime = Date.now();
    const runId = deriveRunId();
    console.log(`[STAGE-1] Sciweon Factory Harvest V0.5.x run_id=${runId}`);

    const cursor = await readCursor();
    const startCid = MANUAL_START_CID > 0 ? MANUAL_START_CID : cursor.next_cid;
    const endCid = startCid + LIMIT_PER_RUN - 1;
    console.log(`[STAGE-1] Cursor: next_cid=${cursor.next_cid}, total_collected=${cursor.total_collected}`);
    console.log(`[STAGE-1] This run: CID ${startCid} to ${endCid} (limit=${LIMIT_PER_RUN})`);

    console.log('\n[STAGE-1] === pubchem-harvester (gate) ===');
    try {
        await runScript('pubchem-harvester.js', [`--start-cid=${startCid}`, `--limit=${LIMIT_PER_RUN}`]);
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

    console.log('\n[STAGE-1] === cross-source-linker (raw -> linked baseline) ===');
    try {
        await runScript('cross-source-linker.js', [`--input=${rawFile}`, `--limit=${LIMIT_PER_RUN}`]);
    } catch (err) {
        console.error(`[STAGE-1] cross-source-linker failed: ${err.message}`);
        try {
            await uploadRaw('pubchem/incremental', runId, [
                [rawFile, path.basename(rawFile)],
            ]);
            console.log('[STAGE-1] Raw uploaded for diagnostic; cursor NOT advanced');
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

    console.log('\n[STAGE-1] === Advance cursor ===');
    try {
        await writeCursor({
            next_cid: endCid + 1,
            last_run_at: new Date().toISOString(),
            last_success_count: LIMIT_PER_RUN,
            total_collected: cursor.total_collected + LIMIT_PER_RUN,
        });
    } catch (err) {
        console.error(`[STAGE-1] Cursor write failed: ${err.message} (data is in R2, but next run retries same range)`);
        process.exit(4);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STAGE-1] === Summary ===`);
    console.log(`  Elapsed:        ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  CID range:      ${startCid} to ${endCid}`);
    console.log(`  Cursor advance: ${cursor.next_cid} -> ${endCid + 1}`);
    console.log(`  R2 run prefix:  processed/baseline/${runId}/`);
    console.log('[STAGE-1] Stage 2 will pick up via workflow_run trigger');
    process.exit(0);
}

main().catch(err => {
    console.error('[STAGE-1] Fatal:', err.message);
    process.exit(1);
});
