/**
 * Stage 1/4 Strategic Harvest — V0.5.3 (Sprint 1c)
 *
 * One-shot harvest of a curated FDA-approved CID subset. Bypasses cursor
 * mechanism (no cursor advance, no range scan). Uses pubchem-harvester's
 * RETRY_CIDS env path to process the explicit CID list, then runs the
 * normal cross-source-linker + uploads as baseline. Stage 2/3/4 cascade
 * via workflow_run trigger (same as natural cron) and V0.5.2.1 cumulative
 * merger replaces any prior records for these CIDs with newer data.
 *
 * Why this exists:
 *   Tier 1 Top 1M Core target includes ~2500 FDA-approved drugs as the
 *   highest-value subset (per LABNEXUS Phase 2.5 #6 + §9.2 Hot Shard
 *   composition). Cursor-based sweep is too slow to reach common drugs
 *   embedded at low CIDs (aspirin 2244, ibuprofen 3672, etc — which were
 *   already harvested in cycle-1 but with race-contaminated NegEvidence).
 *   This workflow re-harvests them with current V0.5.x quality + lands
 *   them in V0.5.2.1 cumulative aggregated bundle on Tier 1.
 *
 * Idempotency: re-running this workflow re-harvests the same CIDs. Stage 3
 * cumulative merge handles dedup via replace-by-id (newer wins).
 *
 * Inputs:
 *   data/strategic-cids-fda-approved.json   curated CID list
 *
 * Outputs:
 *   R2 raw/pubchem/strategic/<run_id>/compounds-strategic-<run_id>.jsonl
 *   R2 processed/baseline/<run_id>/compounds-enriched.jsonl
 *   R2 processed/baseline/<run_id>/bioactivities.jsonl
 *   R2 processed/baseline/latest.json  (pointer for stage 2)
 *
 *   ⚠️ cursor NOT advanced
 *   ⚠️ retry queue NOT modified
 *
 * Exit codes:
 *   0  success — strategic CIDs harvested + baseline uploaded
 *   2  harvester failed (gate / fetch / validation)
 *   3  cross-source-linker failed
 *   4  R2 upload failed
 *   5  no CIDs in input list (degenerate input)
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { uploadStage, uploadRaw, deriveRunId, verifyNonEmpty } from './lib/r2-stage-bridge.js';

const STRATEGIC_LIST = 'scripts/factory/strategic-cids-fda-approved.json';
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

async function loadStrategicCids() {
    const text = await fs.readFile(STRATEGIC_LIST, 'utf-8');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.cids)) {
        throw new Error(`${STRATEGIC_LIST}: expected .cids array`);
    }
    const cids = parsed.cids
        .map(entry => Number(entry?.cid))
        .filter(n => Number.isInteger(n) && n > 0);
    // Dedupe preserving order
    const seen = new Set();
    const unique = [];
    for (const c of cids) {
        if (!seen.has(c)) { seen.add(c); unique.push(c); }
    }
    return { cids: unique, version: parsed.version || 'unknown', source: parsed.source || '' };
}

async function main() {
    const startTime = Date.now();
    const runId = `strategic-${deriveRunId()}`;
    console.log(`[STRATEGIC] Sciweon Factory Strategic Harvest V0.5.3 run_id=${runId}`);

    let strategicSet;
    try {
        strategicSet = await loadStrategicCids();
    } catch (err) {
        console.error(`[STRATEGIC] Failed to load strategic list: ${err.message}`);
        process.exit(5);
    }

    if (strategicSet.cids.length === 0) {
        console.error('[STRATEGIC] No CIDs in strategic list — nothing to do.');
        process.exit(5);
    }

    console.log(`[STRATEGIC] Loaded ${strategicSet.cids.length} CIDs (version ${strategicSet.version})`);
    console.log(`[STRATEGIC] First 10: ${strategicSet.cids.slice(0, 10).join(', ')}${strategicSet.cids.length > 10 ? ' ...' : ''}`);

    // pubchem-harvester accepts RETRY_CIDS env + --limit=0 (no range scan):
    // it processes only the supplied CID list via Pass 1.
    console.log('\n[STRATEGIC] === pubchem-harvester (strategic mode: RETRY_CIDS + --limit=0) ===');
    try {
        await runScript(
            'pubchem-harvester.js',
            ['--start-cid=1', '--limit=0'],
            { RETRY_CIDS: strategicSet.cids.join(',') },
        );
    } catch (err) {
        console.error(`[STRATEGIC] pubchem-harvester failed: ${err.message}`);
        process.exit(2);
    }

    // Harvester writes compounds-cid-<start>-<end>.jsonl. With --start-cid=1
    // --limit=0 the rangeTag is "1-0". File is in ./output/compounds/.
    const rawFile = './output/compounds/compounds-cid-1-0.jsonl';
    try {
        await verifyNonEmpty(rawFile);
    } catch (err) {
        console.error(`[STRATEGIC] Strategic harvest output missing or empty: ${err.message}`);
        process.exit(2);
    }

    console.log('\n[STRATEGIC] === cross-source-linker (raw -> linked baseline) ===');
    try {
        await runScript('cross-source-linker.js', [`--input=${rawFile}`, `--limit=${strategicSet.cids.length}`]);
    } catch (err) {
        console.error(`[STRATEGIC] cross-source-linker failed: ${err.message}`);
        try {
            await uploadRaw('pubchem/strategic', runId, [
                [rawFile, path.basename(rawFile)],
            ]);
            console.log('[STRATEGIC] Raw uploaded for diagnostic');
        } catch (uploadErr) {
            console.error(`[STRATEGIC] Even raw upload failed: ${uploadErr.message}`);
        }
        process.exit(3);
    }

    const baselineFiles = ['compounds-enriched.jsonl', 'bioactivities.jsonl'];
    for (const f of baselineFiles) {
        try {
            await verifyNonEmpty(path.join('./output/linked', f));
        } catch (err) {
            console.error(`[STRATEGIC] Baseline output check failed: ${err.message}`);
            process.exit(3);
        }
    }

    console.log('\n[STRATEGIC] === Upload raw + baseline to R2 ===');
    try {
        await uploadRaw('pubchem/strategic', runId, [
            [rawFile, path.basename(rawFile)],
        ]);
        await uploadStage('baseline', runId, baselineFiles);
    } catch (err) {
        console.error(`[STRATEGIC] R2 upload failed: ${err.message}`);
        process.exit(4);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STRATEGIC] === Summary ===`);
    console.log(`  Elapsed:           ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  Strategic CIDs:    ${strategicSet.cids.length} attempted`);
    console.log(`  R2 run prefix:     processed/baseline/${runId}/`);
    console.log(`  Cursor advance:    NONE (strategic mode bypasses cursor)`);
    console.log(`  Retry queue:       NOT modified`);
    console.log('[STRATEGIC] Stage 2 will pick up via workflow_run trigger');
    process.exit(0);
}

main().catch(err => {
    console.error('[STRATEGIC] Fatal:', err.message);
    process.exit(1);
});
