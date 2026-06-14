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
 *  11  P-8 AUTO publication-policy gate fail-loud (policy missing/mismatch);
 *      a MANUAL_ONLY (backfill_only) artifact is a clean NO-OP exit 0, not 11
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { downloadStage, verifyNonEmpty, makeR2Client as makeBridgeClient } from './lib/r2-stage-bridge.js';
import { resolveAggregatedRunId, runAutoPublishGate, runManualAttestAndDownload } from './lib/stage-4-publish-mode.js';
import {
    loadPreviousSnapshotManifest,
    countJsonlRecords,
    decideGateAction,
    getConfiguredThreshold,
} from './lib/snapshot-history-gate.js';
import { makeR2Client } from './lib/bulk-shard-helpers.js';
import { runShardPublishAndSwap } from './lib/stage-4-shard-orchestrator.js';
import {
    deriveSnapshotId, objectPrefixFor, deriveRunId, deriveRunAttempt, rootSealKey,
} from './lib/snapshot-identity.js';

import { AGGREGATED_FILES } from './lib/aggregated-files.js';
import { verifySnapshotSealPresent } from './lib/stage-4-activate.js';

const SCRIPT_DIR = 'scripts/factory';

const REQUIRED_NONEMPTY = [
    'output/linked/compounds-enriched.jsonl',
];

function runScript(name, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [path.join(SCRIPT_DIR, name)], {
            stdio: 'inherit',
            env: { ...process.env, ...extraEnv },
        });
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`${name} exit ${code}`)));
        child.on('error', reject);
    });
}

async function main() {
    const startTime = Date.now();
    console.log('[STAGE-4] Sciweon Factory Upload V0.5.x');

    // RK-15 PR-B: derive the UNIQUE IMMUTABLE snapshot identity ONCE, up front,
    // and thread it to the spawned builder/uploader (via SNAPSHOT_ID env) AND the
    // shard orchestrator so every object of this publish lands under the same
    // object_prefix `snapshots/<date>/<run_id>-<attempt>/`.
    const snapshotDateEarly = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
        || process.env.TARGET_DATE
        || new Date().toISOString().slice(0, 10);
    const runId = deriveRunId();
    const runAttempt = deriveRunAttempt();
    const snapshotId = deriveSnapshotId(snapshotDateEarly, runId, runAttempt);
    const objectPrefix = objectPrefixFor(snapshotId);
    console.log(`[STAGE-4] Snapshot identity: id=${snapshotId} prefix=${objectPrefix} (run ${runId} attempt ${runAttempt})`);

    // P-8 GAP-C/GAP-A: AUTO vs MANUAL mode. MANUAL (aggregated_run_id provided)
    // binds to one EXACT run id + attests; AUTO (empty) runs the publication-
    // policy gate which NO-OPs on a MANUAL_ONLY (backfill_only) artifact.
    const aggregatedRunId = resolveAggregatedRunId();
    if (aggregatedRunId) {
        console.log(`[STAGE-4] MODE=MANUAL (aggregated_run_id=${aggregatedRunId})`);
        try {
            await runManualAttestAndDownload({ makeClient: makeBridgeClient, aggregatedRunId, files: AGGREGATED_FILES });
        } catch (err) {
            console.error(`[STAGE-4] MANUAL attestation/download FAILED (no publish): ${err.message}`);
            process.exit(2);
        }
    } else {
        console.log('[STAGE-4] MODE=AUTO (no aggregated_run_id input)');
        await runAutoPublishGate({ makeClient: makeBridgeClient }); // PROCEED, or exits (NOOP=0 / FAIL=11)
        console.log('\n[STAGE-4] === Download aggregated from R2 ===');
        try {
            await downloadStage('aggregated', AGGREGATED_FILES);
        } catch (err) {
            console.error(`[STAGE-4] Aggregated download failed: ${err.message}`);
            process.exit(2);
        }
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
        await runScript('snapshot-builder.js', { SNAPSHOT_ID: snapshotId });
    } catch (err) {
        console.error(`[STAGE-4] snapshot-builder failed: ${err.message}`);
        process.exit(3);
    }

    console.log('\n[STAGE-4] === snapshot-uploader ===');
    try {
        await runScript('snapshot-uploader.js', { SNAPSHOT_ID: snapshotId });
    } catch (err) {
        console.error(`[STAGE-4] snapshot-uploader failed: ${err.message}`);
        process.exit(4);
    }

    // Shard publish -> ONE terminal swap -> prune. PR-T1.1-LEVER moved this
    // block into lib/stage-4-shard-orchestrator.js to keep this file under the
    // CES 250-line cap. It publishes compound shards (I-7a) AND the new
    // neg-evidence per-(compound,page) shards, runs the PRESERVE-ALL Sum==wc-l
    // gate, then performs a SINGLE CAS latest.json swap merging both manifest
    // keys (the uploader no longer touches the pointer), then prunes old shards.
    const snapshotDate = snapshotDateEarly;
    const { client, bucket: bucketName, missing } = makeR2Client();
    if (missing.length > 0) {
        console.error(`[STAGE-4] R2 client env missing: ${missing.join(', ')} — refusing to publish shards`);
        process.exit(6);
    }
    await runShardPublishAndSwap({ client, bucketName, snapshotDate, snapshotId, runId, runAttempt, objectPrefix });

    // Cycle 22 PR-L4 / RK-15 PR-B: post-upload R2 presence verification. The F4
    // success claim must be backed by the candidate's listable root seal
    // `<object_prefix>_snapshot.manifest.json` (the seal written LAST). RK-15
    // PR-B moved every object under the immutable object_prefix, so the Layer-4
    // probe targets the seal (not a date-only manifest that no longer exists).
    console.log('\n[STAGE-4] === Post-upload R2 verification ===');
    try {
        const { client: r2c } = makeR2Client();
        const bucket = process.env.R2_BUCKET;
        const present = await verifySnapshotSealPresent(r2c, bucket, objectPrefix);
        if (!present) {
            console.error(`[STAGE-4] FAIL: ${rootSealKey(objectPrefix)} not listable in R2 post-upload — Layer 4 completeness violation`);
            process.exit(10);
        }
        console.log(`[STAGE-4] Post-upload verification OK: ${rootSealKey(objectPrefix)} confirmed in R2`);
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
