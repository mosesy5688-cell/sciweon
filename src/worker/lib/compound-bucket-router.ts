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
