/**
 * stage-4-neg-publish — the neg-evidence publish + preserve-all gate, called
 * by stage-4-upload.js after the compound shards are published. Kept as its own
 * module so stage-4-upload.js stays under the CES 250-line cap.
 *
 * Responsibilities:
 *   1. PRESERVE-ALL gate input: wc-l of the validated neg-evidence.jsonl taken
 *      BEFORE any key skip (the source of truth).
 *   2. publish neg shards (per-bucket NXVF zstd) + drain + integrity verify.
 *   3. HARD-FAIL if Sum(manifest totals over ALL buckets incl orphan) !== wc-l.
 *   4. HARD-FAIL refusing a post-uncap whole-file publish that lacks a sibling
 *      sharded manifest (the snapshot exists but no shards => unsafe to serve).
 *
 * Returns { negManifestKey, stats } for the terminal swap. The terminal swap +
 * prune are owned by stage-4-upload.js (so there is ONE pointer write per F4).
 */

import { createReadStream } from 'fs';
import fs from 'fs/promises';
import readline from 'readline';
import path from 'path';
import { publishNegShards } from './neg-shard-publisher.js';
import { verifyNegShardIntegrity } from './neg-shard-verify.js';

const NEG_JSONL = './output/linked/neg-evidence.jsonl';

/** wc-l of non-empty lines, streaming (BEFORE any key skip). */
export async function countNegLines(jsonlPath = NEG_JSONL) {
    let count = 0;
    const rl = readline.createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
    for await (const line of rl) { if (line.trim()) count++; }
    return count;
}

/**
 * @returns { negManifestKey, manifests, stats } when shards were published, or
 *          { skipped: true, reason } when there is no neg-evidence file (pre-
 *          uncap cold start where neg-evidence is legitimately absent).
 */
export async function publishNegAndGate({
    client, bucket, snapshotDate, drainMs = 90_000, sampleCount = 3, jsonlPath = NEG_JSONL,
}) {
    let st = null;
    try { st = await fs.stat(jsonlPath); } catch { st = null; }
    if (!st || st.size === 0) {
        // No neg-evidence file at all. The whole-file is also absent (builder
        // skips it), so there is no post-uncap unsafe state to guard against.
        return { skipped: true, reason: 'neg-evidence.jsonl absent or empty' };
    }

    // (1) PRESERVE-ALL gate input — taken BEFORE the publisher's key routing.
    const wcl = await countNegLines(jsonlPath);

    // (4) Post-uncap safety: a non-empty neg-evidence whole-file MUST get a
    // sibling sharded manifest. If the publish produced zero buckets while the
    // file is non-empty, refuse (do not publish a whole-file with no shards).
    const outputRoot = './snapshots';
    const result = await publishNegShards({ client, bucket, jsonlPath, snapshotDate, outputRoot });
    if (wcl > 0 && result.bucketCount === 0) {
        throw new Error(`[NEG] ${wcl} records but 0 sharded buckets produced — refusing whole-file publish without sibling shards`);
    }

    // (3) PRESERVE-ALL hard-fail: Sum(totals over ALL buckets) === wc-l.
    if (result.sumOfTotals !== wcl) {
        throw new Error(`[NEG] PRESERVE-ALL violation: sum(manifest totals)=${result.sumOfTotals} != wc-l=${wcl}`);
    }

    // (2 cont) drain + integrity verify across random (bucket, shard) pairs.
    console.log(`[NEG] Drain wait ${drainMs / 1000}s (Constitution V16.1 §9)`);
    await new Promise(r => setTimeout(r, drainMs));
    await verifyNegShardIntegrity(client, bucket, snapshotDate, result.manifests, sampleCount);
    console.log(`[NEG] Integrity probes PASS (${result.bucketCount} buckets, ${result.shardCount} shards, ${wcl} records)`);

    // The neg manifest "pointer" addresses the bucket-0000 manifest as the
    // canonical sentinel that the sharded snapshot exists; the worker computes
    // the actual per-key bucket manifest path itself from the date.
    const negManifestKey = `snapshots/${snapshotDate}/neg-evidence/`;
    return {
        skipped: false,
        negManifestKey,
        manifests: result.manifests,
        stats: {
            records: wcl, buckets: result.bucketCount, shards: result.shardCount, elapsedSec: result.elapsedSec,
        },
    };
}

export { NEG_JSONL };
