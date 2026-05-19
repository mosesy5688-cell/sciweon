/**
 * Stage 4/4 — Upload (V0.5.x refactor)
 *
 * Reads aggregated bundle from R2, builds dated snapshot, uploads to R2
 * snapshots/<date>/, updates linked/latest.json pointer. Data integrity
 * check enforced before snapshot is published.
 *
 * Inputs (R2):
 *   processed/aggregated/<latest>/*.jsonl
 *
 * Outputs (R2):
 *   snapshots/<YYYY-MM-DD>/*.jsonl.gz + manifest.json
 *   snapshots/latest.json (pointer)
 *
 * Exit codes:
 *   0  snapshot built + uploaded + latest pointer updated
 *   1  aggregated download succeeded but data integrity check failed
 *   2  aggregated download failed
 *   3  snapshot-builder failed
 *   4  snapshot-uploader failed
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { downloadStage, verifyNonEmpty } from './lib/r2-stage-bridge.js';
import {
    loadPreviousSnapshotManifest,
    countJsonlRecords,
    decideGateAction,
    getConfiguredThreshold,
} from './lib/snapshot-history-gate.js';

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
];

const REQUIRED_NONEMPTY = [
    'output/linked/compounds-enriched.jsonl',
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

async function main() {
    const startTime = Date.now();
    console.log('[STAGE-4] Sciweon Factory Upload V0.5.x');

    console.log('\n[STAGE-4] === Download aggregated from R2 ===');
    try {
        await downloadStage('aggregated', AGGREGATED_FILES);
    } catch (err) {
        console.error(`[STAGE-4] Aggregated download failed: ${err.message}`);
        process.exit(2);
    }

    console.log('\n[STAGE-4] === Data integrity check ===');
    for (const f of REQUIRED_NONEMPTY) {
        try {
            const size = await verifyNonEmpty(f, 100);
            console.log(`  ${f}: ${(size / 1024).toFixed(1)} KB OK`);
        } catch (err) {
            console.error(`[STAGE-4] Integrity check failed: ${err.message}`);
            console.error('[STAGE-4] Refusing to publish empty snapshot');
            process.exit(1);
        }
    }

    // V0.5.5 — historical-comparison gate. Defense-in-depth for
    // [[feedback_cross_cycle_silent_data_loss]] even when stage-3 sentinel
    // (H1-2) slips through. Compare current compounds-enriched record count
    // vs previous snapshot manifest; abort publish if drop > threshold.
    // 2026-05-18 production regression (-83%) sailed past `verifyNonEmpty`
    // because 5000 records × 1.9KB = ~9MB >> 100-byte threshold. This gate
    // enforces a historical (not content-presence) check.
    console.log('\n[STAGE-4] === Historical-comparison gate ===');
    try {
        const thresholdPct = getConfiguredThreshold();
        const currentRecords = await countJsonlRecords(REQUIRED_NONEMPTY[0]);
        const previousManifest = await loadPreviousSnapshotManifest();
        const previousRecords = previousManifest?.files?.find(
            f => f.filename === 'compounds-enriched.jsonl.gz'
        )?.records ?? null;
        const action = decideGateAction({ currentRecords, previousRecords, thresholdPct });
        switch (action.kind) {
            case 'skip_no_previous':
                console.log(`  [GATE] ${action.reason} — gate skipped (first-ever publish)`);
                break;
            case 'pass':
                console.log(`  [GATE] PASS — current ${action.currentRecords} vs previous ${action.previousRecords} (drop ${action.dropPct}%, threshold ${thresholdPct}%)`);
                break;
            case 'abort_regression':
                console.error(`  [GATE] FAIL — current ${action.currentRecords} vs previous ${action.previousRecords} (drop ${action.dropPct}% > threshold ${thresholdPct}%)`);
                console.error('[STAGE-4] Refusing to publish suspected regression — manual review required.');
                console.error('[STAGE-4] If this drop is legitimate (e.g. data source cleanup), set SCIWEON_RECORD_DROP_THRESHOLD_PCT=<higher> and re-run.');
                process.exit(5);
                break;
        }
    } catch (err) {
        console.error(`[STAGE-4] Historical gate failed to evaluate: ${err.message}`);
        console.error('[STAGE-4] Refusing to publish — gate must succeed (operator verify previous snapshot integrity).');
        process.exit(5);
    }

    console.log('\n[STAGE-4] === snapshot-builder ===');
    try {
        await runScript('snapshot-builder.js');
    } catch (err) {
        console.error(`[STAGE-4] snapshot-builder failed: ${err.message}`);
        process.exit(3);
    }

    console.log('\n[STAGE-4] === snapshot-uploader ===');
    try {
        await runScript('snapshot-uploader.js');
    } catch (err) {
        console.error(`[STAGE-4] snapshot-uploader failed: ${err.message}`);
        process.exit(4);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STAGE-4] === Summary ===`);
    console.log(`  Elapsed:        ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  Snapshot:       uploaded to R2 snapshots/<date>/`);
    console.log(`  Latest pointer: updated`);
    console.log('[STAGE-4] Pipeline complete');
    process.exit(0);
}

main().catch(err => {
    console.error('[STAGE-4] Fatal:', err.message);
    process.exit(1);
});
