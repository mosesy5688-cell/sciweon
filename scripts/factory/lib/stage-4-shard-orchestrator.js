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
 */

import path from 'path';
import { publishCompoundShards } from './compound-shard-publisher.js';
import { verifyShardIntegrity } from './compound-shard-pointer.js';
import { swapLatestPointer } from './publish-shards-and-swap.js';
import { publishNegAndGate } from './stage-4-neg-publish.js';
import { pruneOldNegShards } from './neg-shard-prune.js';

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
