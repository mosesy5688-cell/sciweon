/**
 * Snapshot Backfill V0.7 (cycle 22 PR-L4) — reconstruct missing Layer 4 snapshot.
 *
 * On-demand backfill for a specific date that was missed by F4 cron.
 * Downloads the nearest-prior aggregated bundle from R2, runs builder +
 * uploader with TARGET_DATE env override, verifies post-upload.
 *
 * Idempotent: if snapshots/<target>/manifest.json already exists in R2,
 * early-exit (no overwrite).
 *
 * SKIP_LATEST_SWAP env always set: backfilled snapshot is OLD, must NOT
 * advance latest.json pointer (which tracks the most recent snapshot).
 *
 * Documented limitations (transparent, not hidden):
 *   - Backfilled snapshot reflects nearest-prior aggregated run, not the
 *     target_date data state itself. Manifest records source run_id so
 *     downstream consumers can audit provenance.
 *   - Only Tier 1 cumulative-derived artifacts are restored (drug-labels,
 *     neg-evidence, search-index, target-index, etc.). Tier 2 PubChem bulk
 *     shards have independent monthly refresh — not touched here.
 *   - Compounds NXVF shards are rebuilt from the nearest-prior bundle, so
 *     compound counts may reflect slightly stale state.
 *
 * Usage:
 *   node snapshot-backfill.js --date=YYYY-MM-DD [--dry-run]
 *
 * Exit codes:
 *   0  success (snapshot present in R2 post-run)
 *   1  no aggregated run available for backfill
 *   2  snapshot-builder or snapshot-uploader subprocess failure
 *   3  post-upload verification failed (snapshot not listable)
 *   4  R2 access failure
 *   5  CLI arg invalid
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
    makeR2Client, verifySnapshotPresent, findNearestPriorAggregated,
} from './lib/snapshot-bridge.js';
import { AGGREGATED_FILES } from './lib/aggregated-files.js';

const LINKED_DIR = './output/linked';
const SCRIPT_DIR = 'scripts/factory';

function parseArgs() {
    const args = process.argv.slice(2);
    const date = args.find(a => a.startsWith('--date='))?.split('=')[1];
    const dryRun = args.includes('--dry-run');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error('--date=YYYY-MM-DD required');
    }
    return { date, dryRun };
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function downloadAggregatedBundle(client, bucket, runId, dryRun) {
    await fs.mkdir(LINKED_DIR, { recursive: true });
    if (dryRun) {
        console.log(`[BACKFILL] [dry-run] would download ${AGGREGATED_FILES.length} files from processed/aggregated/${runId}/`);
        return;
    }
    let total = 0;
    for (const fname of AGGREGATED_FILES) {
        const key = `processed/aggregated/${runId}/${fname}`;
        try {
            const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const buf = await streamToBuffer(res.Body);
            await fs.writeFile(path.join(LINKED_DIR, fname), buf);
            total += buf.length;
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                console.warn(`[BACKFILL] ${fname} absent in run ${runId} — skip (will be reflected as gap in backfilled snapshot)`);
            } else {
                throw err;
            }
        }
    }
    console.log(`[BACKFILL] Downloaded aggregated bundle from run ${runId}: ${(total / 1024 / 1024).toFixed(2)} MB total`);
}

function runScript(name, env = {}) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(SCRIPT_DIR, name);
        const child = spawn('node', [scriptPath], {
            stdio: 'inherit',
            env: { ...process.env, ...env },
        });
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`${name} exit ${code}`)));
        child.on('error', reject);
    });
}

async function main() {
    let date, dryRun;
    try {
        ({ date, dryRun } = parseArgs());
    } catch (err) {
        console.error(`[BACKFILL] ${err.message}`);
        process.exit(5);
    }
    console.log(`[BACKFILL] target_date=${date} dry_run=${dryRun}`);

    let client, bucket;
    try {
        client = makeR2Client();
        bucket = process.env.R2_BUCKET;
    } catch (err) {
        console.error(`[BACKFILL] R2 init failed: ${err.message}`);
        process.exit(4);
    }

    // Idempotency check
    if (await verifySnapshotPresent(client, bucket, date)) {
        console.log(`[BACKFILL] snapshots/${date}/manifest.json already exists — early exit (idempotent)`);
        process.exit(0);
    }

    // Find nearest prior aggregated run
    console.log(`[BACKFILL] Finding nearest prior aggregated run for ${date}...`);
    const runId = await findNearestPriorAggregated(client, bucket, date);
    if (!runId) {
        console.error(`[BACKFILL] No aggregated runs found in R2 — cannot backfill ${date}`);
        process.exit(1);
    }
    console.log(`[BACKFILL] Using aggregated run ${runId} as source`);

    // Download bundle to local /output/linked/
    await downloadAggregatedBundle(client, bucket, runId, dryRun);

    if (dryRun) {
        console.log(`[BACKFILL] [dry-run] would invoke snapshot-builder + snapshot-uploader with TARGET_DATE=${date} SKIP_LATEST_SWAP=1`);
        process.exit(0);
    }

    // Run builder + uploader with TARGET_DATE override + SKIP_LATEST_SWAP
    const env = {
        TARGET_DATE: date,
        SKIP_LATEST_SWAP: '1',
        BACKFILL_SOURCE_RUN_ID: runId,
    };
    try {
        await runScript('snapshot-builder.js', env);
    } catch (err) {
        console.error(`[BACKFILL] snapshot-builder failed: ${err.message}`);
        process.exit(2);
    }
    try {
        await runScript('snapshot-uploader.js', env);
    } catch (err) {
        console.error(`[BACKFILL] snapshot-uploader failed: ${err.message}`);
        process.exit(2);
    }

    // Post-upload verify
    const present = await verifySnapshotPresent(client, bucket, date);
    if (!present) {
        console.error(`[BACKFILL] Post-upload verification failed: snapshots/${date}/manifest.json not listable in R2`);
        process.exit(3);
    }

    console.log(`[BACKFILL] === Success ===`);
    console.log(`  target_date:       ${date}`);
    console.log(`  source_run_id:     ${runId}`);
    console.log(`  R2 snapshot key:   snapshots/${date}/manifest.json`);
    console.log(`  latest.json:       NOT swapped (backfill of old date, per SKIP_LATEST_SWAP)`);
    process.exit(0);
}

main().catch(err => {
    console.error('[BACKFILL] Fatal:', err);
    process.exit(4);
});
