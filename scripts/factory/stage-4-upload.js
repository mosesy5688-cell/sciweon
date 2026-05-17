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
