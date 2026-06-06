/**
 * stage-4-shard-orchestrator — the shard publish -> ONE terminal swap -> prune
 * flow, extracted from stage-4-upload.js to keep it under the CES 250-line cap.
 *
 * Order (the safe internal sequence):
 *   1. publish compound shards (no swap yet)
 *   2. drain 90s + compound integrity probes
 *   3. publish neg shards + PRESERVE-ALL gate (Sum==wc-l) + integrity probes
 *   4. ONE terminal swapLatestPointer merging compound + neg keys (CAS)
 *   5. old-shard prune (non-fatal) AFTER the swap
 *
 * Exit codes preserved from the original stage-4 block:
 *   7 compound publish fail · 8 compound integrity fail · 11 neg publish/gate
 *   fail · 9 swap fail. Prune failure is non-fatal (warn).
 *   12 (PR-COMPOUND-GUARD): a compound SERVING projection .gz key is absent
 *   pre-swap -> refuse to swap latest.json (mirror the compound-shard exit 7).
 */

import path from 'path';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { publishCompoundShards } from './compound-shard-publisher.js';
import { verifyShardIntegrity } from './compound-shard-pointer.js';
import { swapLatestPointer } from './publish-shards-and-swap.js';
import { publishNegAndGate } from './stage-4-neg-publish.js';
import { pruneOldNegShards } from './neg-shard-prune.js';

// PR-COMPOUND-GUARD: the two serving projection R2 keys snapshot-uploader writes
// under snapshots/<date>/ (xref-index.json gzips to xref-index.json.gz). The
// worker resolve/search paths depend on them, so refuse to swap latest.json if
// either is absent (a stale-pointer-over-missing-projection availability bug).
function projectionKeys(snapshotDate) {
    return [
        `snapshots/${snapshotDate}/compounds-search.jsonl.gz`,
        `snapshots/${snapshotDate}/xref-index.json.gz`,
    ];
}

async function objectExists(client, bucket, key) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (err) {
        if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return false;
        }
        throw err; // transient/auth error is not an absence signal -> propagate
    }
}

/**
 * Probe both projection .gz keys. Returns { ok, missing[] }. A transient/auth
 * head() error propagates (the caller treats a probe error as a refusal too).
 * Exported so the guard's presence logic is unit-testable without the 90s drain.
 */
export async function compoundProjectionsPresent(client, bucket, snapshotDate) {
    const missing = [];
    for (const key of projectionKeys(snapshotDate)) {
        if (!(await objectExists(client, bucket, key))) missing.push(key);
    }
    return { ok: missing.length === 0, missing };
}

export async function runShardPublishAndSwap({ client, bucketName, snapshotDate }) {
    // 1. Compound shards.
    console.log('\n[STAGE-4] === Compound shard publish (I-7a Phase 1) ===');
    const jsonlPath = './output/linked/compounds-enriched.jsonl';
    const shardOutDir = path.join('./snapshots', snapshotDate, 'compounds', 'bucket-0000');
    let publishResult;
    try {
        publishResult = await publishCompoundShards({ client, bucket: bucketName, jsonlPath, snapshotDate, outputDir: shardOutDir });
        console.log(`[STAGE-4] Published ${publishResult.stats.shardCount} compound shards `
            + `(${publishResult.stats.totalMB} MB, ${publishResult.stats.recordCount} records) — manifest ${publishResult.manifestKey}`);
    } catch (err) {
        console.error(`[STAGE-4] Compound shard publish FAILED: ${err.message}`);
        console.error('[STAGE-4] Refusing to swap latest.json pointer — sharded path unavailable to workers.');
        process.exit(7);
    }

    // 2. Drain + compound integrity.
    console.log('\n[STAGE-4] === Drain wait 90s (Constitution V16.1 §9) ===');
    await new Promise(r => setTimeout(r, 90_000));
    try {
        await verifyShardIntegrity(client, bucketName, snapshotDate, publishResult.manifest, 3);
        console.log('[STAGE-4] All 3 compound integrity probes PASS');
    } catch (err) {
        console.error(`[STAGE-4] Compound integrity probe FAILED: ${err.message}`);
        process.exit(8);
    }

    // 3. Neg shards + PRESERVE-ALL gate (+ its own drain/verify).
    console.log('\n[STAGE-4] === NegEvidence shard publish (PR-T1.1-LEVER) ===');
    let negResult;
    try {
        negResult = await publishNegAndGate({ client, bucket: bucketName, snapshotDate });
        if (negResult.skipped) console.log(`[STAGE-4] Neg shard publish skipped: ${negResult.reason}`);
        else console.log(`[STAGE-4] Neg shards published + verified: ${negResult.stats.records} records, `
            + `${negResult.stats.buckets} buckets, ${negResult.stats.shards} shards`);
    } catch (err) {
        console.error(`[STAGE-4] Neg shard publish/gate FAILED: ${err.message}`);
        console.error('[STAGE-4] Refusing to swap latest.json pointer — neg sharded path unsafe/incomplete.');
        process.exit(11);
    }

    // 3b. PR-COMPOUND-GUARD pre-swap PRESENCE PROBE: both serving projection .gz
    // keys must exist under snapshots/<date>/ before the terminal swap (mirror
    // the compound-shard exit 7 guard). snapshot-uploader uploads every
    // snapshots/<date>/ file BEFORE this orchestrator runs the swap, so an absent
    // key means the projection was never produced -> refuse to advance latest.json.
    console.log('\n[STAGE-4] === Compound projection presence probe (pre-swap) ===');
    let probe;
    try {
        probe = await compoundProjectionsPresent(client, bucketName, snapshotDate);
    } catch (err) {
        console.error(`[STAGE-4] Compound projection head() errored: ${err.message}`);
        console.error('[STAGE-4] Refusing to swap latest.json -- compound projection probe errored.');
        process.exit(12);
    }
    if (!probe.ok) {
        console.error(`[STAGE-4] Compound projection missing: ${probe.missing.join(', ')}`);
        console.error('[STAGE-4] Refusing to swap latest.json -- compound projection missing');
        process.exit(12);
    }
    console.log('[STAGE-4] Both compound projections present (pre-swap probe PASS)');

    // 4. ONE terminal swap (compound + neg keys).
    console.log('\n[STAGE-4] === ONE terminal latest.json swap (compound + neg keys) ===');
    const swapUpdates = {
        latest_snapshot_date: snapshotDate,
        manifest_key: `snapshots/${snapshotDate}/manifest.json`,
        compounds_manifest_key: publishResult.manifestKey,
    };
    const expectKeys = ['latest_snapshot_date', 'compounds_manifest_key'];
    if (!negResult.skipped) {
        swapUpdates.neg_evidence_manifest_key = negResult.negManifestKey;
        expectKeys.push('neg_evidence_manifest_key');
    } else {
        // FIX M4 ([[cross_cycle_silent_data_loss]] availability facet): on a
        // SKIPPED-neg run, latest_snapshot_date still advances. Without this, the
        // prior-day neg_evidence_manifest_key SURVIVES the {...current,...updates}
        // merge while pointing at a date with NO neg shards -> the worker computes
        // a per-bucket manifest path that 404s -> /negative-evidence 503s ALL DAY.
        // Explicitly CLEAR the stale key so the worker's dual-path sees it absent
        // (negShardingActive does Boolean(key) -> null is falsy -> legacy whole-file
        // path, HEAD.size-guarded, safe). swapLatestPointer must drop a null value
        // from the merged latest.json (see publish-shards-and-swap.js).
        swapUpdates.neg_evidence_manifest_key = null;
    }
    try {
        const updated = await swapLatestPointer(client, bucketName, swapUpdates, expectKeys);
        console.log(`[STAGE-4] latest.json updated: ${JSON.stringify(updated)}`);
    } catch (err) {
        console.error(`[STAGE-4] latest.json pointer swap FAILED: ${err.message}`);
        process.exit(9);
    }

    // 5. Old-shard prune AFTER the swap (non-fatal).
    console.log('\n[STAGE-4] === NegEvidence old-shard prune ===');
    try {
        const pruneRes = await pruneOldNegShards(client, bucketName, snapshotDate, 2);
        console.log(`[STAGE-4] Neg prune: kept ${pruneRes.keptDates.join(',')}; `
            + `pruned ${pruneRes.prunedDates.join(',') || '(none)'} (${pruneRes.deletedKeys} keys)`);
    } catch (err) {
        console.warn(`[STAGE-4] Neg prune skipped (non-fatal): ${err.message}`);
    }
}
