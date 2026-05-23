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
import { makeR2Client } from './lib/bulk-shard-helpers.js';
import { publishCompoundShards } from './lib/compound-shard-publisher.js';
import { verifyShardIntegrity, updateLatestPointer } from './lib/compound-shard-pointer.js';

import { AGGREGATED_FILES } from './lib/aggregated-files.js';
import { verifySnapshotPresent } from './lib/snapshot-bridge.js';

const SCRIPT_DIR = 'scripts/factory';

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

    // I-7a (Wave I-7a Phase 1): NXVF binary shards + JSON manifest published
    // to snapshots/<date>/compounds/bucket-0000/. Workers Range-read single
    // record (~2 KB) instead of full-bundle scan (85 MB at 45K cliff).
    // Per Constitution V16.1 §9: 90s drain wait + 3 random integrity probes
    // before atomic pointer swap. Hard-fail per feedback_cross_cycle_silent_data_loss.
    console.log('\n[STAGE-4] === Compound shard publish (I-7a Phase 1) ===');
    const snapshotDate = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
        || new Date().toISOString().slice(0, 10);
    const jsonlPath = './output/linked/compounds-enriched.jsonl';
    const shardOutDir = path.join('./snapshots', snapshotDate, 'compounds', 'bucket-0000');
    const { client, bucket: bucketName, missing } = makeR2Client();
    if (missing.length > 0) {
        console.error(`[STAGE-4] R2 client env missing: ${missing.join(', ')} — refusing to publish shards`);
        process.exit(6);
    }
    let publishResult;
    try {
        publishResult = await publishCompoundShards({
            client, bucket: bucketName, jsonlPath, snapshotDate, outputDir: shardOutDir,
        });
        console.log(`[STAGE-4] Published ${publishResult.stats.shardCount} shards `
            + `(${publishResult.stats.totalMB} MB, ${publishResult.stats.recordCount} records) `
            + `in ${publishResult.stats.elapsedSec}s — manifest ${publishResult.manifestKey}`);
    } catch (err) {
        console.error(`[STAGE-4] Compound shard publish FAILED: ${err.message}`);
        console.error('[STAGE-4] Refusing to swap latest.json pointer — sharded path unavailable to workers.');
        process.exit(7);
    }
    console.log('\n[STAGE-4] === Drain wait 90s (Constitution V16.1 §9) ===');
    await new Promise(r => setTimeout(r, 90_000));
    console.log('\n[STAGE-4] === Integrity probes (3 random shards) ===');
    try {
        await verifyShardIntegrity(client, bucketName, snapshotDate, publishResult.manifest, 3);
        console.log('[STAGE-4] All 3 integrity probes PASS');
    } catch (err) {
        console.error(`[STAGE-4] Integrity probe FAILED: ${err.message}`);
        console.error('[STAGE-4] Refusing to swap latest.json pointer — shard bytes mismatch detected.');
        process.exit(8);
    }
    console.log('\n[STAGE-4] === Atomic latest.json swap (add compounds_manifest_key) ===');
    try {
        const updated = await updateLatestPointer(client, bucketName, {
            snapshotDate,
            compoundsManifestKey: publishResult.manifestKey,
        });
        console.log(`[STAGE-4] latest.json updated: ${JSON.stringify(updated)}`);
    } catch (err) {
        console.error(`[STAGE-4] latest.json pointer swap FAILED: ${err.message}`);
        process.exit(9);
    }

    // Cycle 22 PR-L4: post-upload R2 presence verification. F4 success
    // claim must be backed by actual listable snapshot/<today>/manifest.json
    // — otherwise silently fails Layer 4 完整性 leg of triple-lock. Same
    // HARDFAIL defense pattern as cycle 21 PR #4/#112/#113 SSoT guards.
    console.log('\n[STAGE-4] === Post-upload R2 verification ===');
    const todayIso = new Date().toISOString().slice(0, 10);
    try {
        const r2c = makeR2Client();
        const bucket = process.env.R2_BUCKET;
        const present = await verifySnapshotPresent(r2c, bucket, todayIso);
        if (!present) {
            console.error(`[STAGE-4] FAIL: snapshots/${todayIso}/manifest.json not listable in R2 post-upload — Layer 4 完整性 violation`);
            process.exit(10);
        }
        console.log(`[STAGE-4] Post-upload verification OK: snapshots/${todayIso}/manifest.json confirmed in R2`);
    } catch (err) {
        console.error(`[STAGE-4] Post-upload verification ERROR: ${err.message}`);
        process.exit(10);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[STAGE-4] === Summary ===`);
    console.log(`  Elapsed:        ${elapsed}s (${(elapsed / 60).toFixed(1)} min)`);
    console.log(`  Snapshot:       uploaded to R2 snapshots/<date>/`);
    console.log(`  Latest pointer: updated`);
    console.log(`  Post-upload:    verified present in R2`);
    console.log('[STAGE-4] Pipeline complete');
    process.exit(0);
}

main().catch(err => {
    console.error('[STAGE-4] Fatal:', err.message);
    process.exit(1);
});
