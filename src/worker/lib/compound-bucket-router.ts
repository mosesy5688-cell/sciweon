/**
 * Compound bucket router — Wave I-7a forward-compat anchor.
 *
 * Phase 1 (THIS): BUCKET_COUNT = 1, getBucket() returns 0.
 * Phase 3 (I-9, 10M trigger): BUCKET_COUNT = 1024, getBucket() body becomes
 *   `return Math.abs(hashCid(cid)) % BUCKET_COUNT`.
 *
 * Call sites in worker (compound-loader.ts, manifest-loader.ts) treat the
 * bucket as a routed dimension from day 1. Phase 3 migration is body-only,
 * zero caller change. This is the DynamoDB partition-key analog.
 */

export const BUCKET_COUNT = 1;

export function getBucket(cid: number): number {
    // Phase 1 (I-7a, 30K-1M scale): single bucket. All CIDs → bucket-0000.
    // Phase 3 (I-9, 10M+ scale): replace with hash partition.
    return 0;
}

export function bucketKey(snapshotDate: string, bucket: number): string {
    const padded = String(bucket).padStart(4, '0');
    return `snapshots/${snapshotDate}/compounds/bucket-${padded}`;
}

export function shardKeyFor(snapshotDate: string, bucket: number, shard: number): string {
    return `${bucketKey(snapshotDate, bucket)}/shard-${String(shard).padStart(3, '0')}.bin`;
}

export function manifestKeyFor(snapshotDate: string, bucket: number): string {
    return `${bucketKey(snapshotDate, bucket)}/manifest.json`;
}

/**
 * RK-15 PR-A — context-aware key derivation.
 *
 * legacy_v1: date-derived (the v1 contract, unchanged).
 * immutable_snapshot_v2: derived RELATIVE to the declared compounds_manifest_key
 *   prefix — NEVER reassembled from a date/run_id. The v2 producer declares
 *   `.../compounds/bucket-NNNN/manifest.json`; the bucket prefix is that
 *   manifest's parent dir, and shards are siblings under it.
 */
import type { SnapshotContext } from './snapshot-context';

function padBucket(bucket: number): string {
    return String(bucket).padStart(4, '0');
}
function padShard(shard: number): string {
    return String(shard).padStart(3, '0');
}

/** v2 compounds-root: the declared compounds_manifest_key's grandparent
 * `.../compounds/` (strip `bucket-NNNN/manifest.json`). */
function v2CompoundsRoot(ctx: SnapshotContext): string {
    const key = ctx.compounds_manifest_key;
    if (!key) {
        throw new Error('immutable_snapshot_v2 context lacks compounds_manifest_key');
    }
    // Declared form: <prefix>/compounds/bucket-NNNN/manifest.json
    const marker = '/compounds/';
    const i = key.indexOf(marker);
    if (i < 0) {
        throw new Error(`v2 compounds_manifest_key has no /compounds/ segment: ${key}`);
    }
    return key.slice(0, i + marker.length); // ends with `compounds/`
}

export function manifestKeyForCtx(ctx: SnapshotContext, bucket: number): string {
    if (ctx.layout_version === 'immutable_snapshot_v2') {
        return `${v2CompoundsRoot(ctx)}bucket-${padBucket(bucket)}/manifest.json`;
    }
    return manifestKeyFor(ctx.snapshot_date, bucket);
}

export function shardKeyForCtx(ctx: SnapshotContext, bucket: number, shard: number): string {
    if (ctx.layout_version === 'immutable_snapshot_v2') {
        return `${v2CompoundsRoot(ctx)}bucket-${padBucket(bucket)}/shard-${padShard(shard)}.bin`;
    }
    return shardKeyFor(ctx.snapshot_date, bucket, shard);
}
