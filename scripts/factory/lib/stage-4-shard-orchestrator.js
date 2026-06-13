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
import { publishNegAndGate } from './stage-4-neg-publish.js';
import { pruneOldNegShards } from './neg-shard-prune.js';
import {
    objectPrefixFor, deriveSnapshotId, searchProjectionKey, xrefIndexKey, PUBLISH_STATES,
} from './snapshot-identity.js';
import { activateValidatedCandidate } from './stage-4-activate.js';

// PR-COMPOUND-GUARD / RK-15 PR-B: the two serving projection keys live under the
// candidate object_prefix (xref-index.json gzips to xref-index.json.gz). The
// worker resolve/search paths depend on them, so refuse to activate if either is
// absent (a stale-pointer-over-missing-projection availability bug).
function projectionKeys(objectPrefix) {
    return [searchProjectionKey(objectPrefix), xrefIndexKey(objectPrefix)];
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
export async function compoundProjectionsPresent(client, bucket, objectPrefix) {
    const missing = [];
    for (const key of projectionKeys(objectPrefix)) {
        if (!(await objectExists(client, bucket, key))) missing.push(key);
    }
    return { ok: missing.length === 0, missing };
}

export async function runShardPublishAndSwap({
    client, bucketName, snapshotDate, snapshotId, runId, runAttempt, objectPrefix, commitSha,
}) {
    // RK-15 PR-B: the immutable identity is the SINGLE coordinate. A caller that
    // passes only a date (legacy backfill/test) gets a derived identity so old
    // behavior is preserved; the live F4 path passes the orchestration identity.
    const id = snapshotId || deriveSnapshotId(snapshotDate);
    const prefix = objectPrefix || objectPrefixFor(id);
    const identity = {
        snapshotId: id, objectPrefix: prefix, snapshotDate,
        runId: runId ?? null, runAttempt: runAttempt ?? null,
        commitSha: commitSha ?? process.env.GITHUB_SHA ?? null,
    };
    console.log(`[STAGE-4] === Publish state: ${PUBLISH_STATES.BUILDING} (id ${id}, prefix ${prefix}) ===`);

    // 1. Compound shards (create-only, under the candidate object_prefix).
    console.log('\n[STAGE-4] === Compound shard publish (I-7a Phase 1) ===');
    const jsonlPath = './output/linked/compounds-enriched.jsonl';
    const shardOutDir = path.join('./snapshots', snapshotDate, 'compounds', 'bucket-0000');
    let publishResult;
    try {
        publishResult = await publishCompoundShards({ client, bucket: bucketName, jsonlPath, snapshotDate, outputDir: shardOutDir, objectPrefix: prefix });
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
        negResult = await publishNegAndGate({ client, bucket: bucketName, snapshotDate, objectPrefix: prefix });
        if (negResult.skipped) console.log(`[STAGE-4] Neg shard publish skipped: ${negResult.reason}`);
        else console.log(`[STAGE-4] Neg shards published + verified: ${negResult.stats.records} records, `
            + `${negResult.stats.buckets} buckets, ${negResult.stats.shards} shards`);
    } catch (err) {
        console.error(`[STAGE-4] Neg shard publish/gate FAILED: ${err.message}`);
        console.error('[STAGE-4] Refusing to swap latest.json pointer — neg sharded path unsafe/incomplete.');
        process.exit(11);
    }

    // 3b. PR-COMPOUND-GUARD presence probe: both serving projection .gz keys must
    // exist UNDER THE CANDIDATE object_prefix before activation (mirror the
    // compound-shard exit 7 guard). snapshot-uploader writes them under the
    // object_prefix BEFORE this orchestrator runs; an absent key means the
    // projection was never produced -> refuse to activate latest.json.
    console.log('\n[STAGE-4] === Compound projection presence probe (pre-activate) ===');
    let probe;
    try {
        probe = await compoundProjectionsPresent(client, bucketName, prefix);
    } catch (err) {
        console.error(`[STAGE-4] Compound projection head() errored: ${err.message}`);
        console.error('[STAGE-4] Refusing to activate -- compound projection probe errored.');
        process.exit(12);
    }
    if (!probe.ok) {
        console.error(`[STAGE-4] Compound projection missing: ${probe.missing.join(', ')}`);
        console.error('[STAGE-4] Refusing to activate -- compound projection missing');
        process.exit(12);
    }
    console.log('[STAGE-4] Both compound projections present (probe PASS)');

    // 4. VALIDATED ACTIVATION: seal LAST -> validate candidate by ITS OWN keys
    // (never latest.json) -> CAS the v2 latest.json -> post-swap active probe.
    // Any failure here leaves the OLD latest untouched (the candidate is retained
    // under its own run-id prefix, undiscoverable by an active reader).
    try {
        const activation = await activateValidatedCandidate({
            client, bucket: bucketName, identity,
            compoundManifest: publishResult.manifest,
            negManifestKey: negResult.skipped ? null : negResult.negManifestKey,
            hasXref: true, hasSearch: true,
        });
        console.log(`[STAGE-4] Candidate ACTIVE: manifest_hash=${activation.manifestHash.slice(0, 16)}... `
            + `latest -> snapshot_id ${id}`);
    } catch (err) {
        console.error(`[STAGE-4] Validated activation FAILED: ${err.message}`);
        console.error('[STAGE-4] latest.json left UNCHANGED — candidate retained but NOT active.');
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
