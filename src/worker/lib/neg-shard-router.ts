/**
 * NegEvidence shard router — worker-side key/prefix derivation, mirroring
 * compound-bucket-router.ts but for the per-bucket NegEvidence sharding.
 *
 * Layout (producer = scripts/factory/lib/neg-shard-publisher.js):
 *   snapshots/<date>/neg-evidence/bucket-NNNN/shard-MMM.bin    (NXVF zstd entities)
 *   snapshots/<date>/neg-evidence/bucket-NNNN/manifest.json    (per-bucket index)
 *
 * bucket = negBucketOf(key) in [0, NEG_BUCKET_COUNT). 4-digit bucket + 3-digit
 * shard padding, identical convention to the compound shards.
 */

function pad4(n: number): string {
    return String(n).padStart(4, '0');
}
function pad3(n: number): string {
    return String(n).padStart(3, '0');
}

export function negBucketPrefix(snapshotDate: string, bucket: number): string {
    return `snapshots/${snapshotDate}/neg-evidence/bucket-${pad4(bucket)}`;
}

export function negShardKeyFor(snapshotDate: string, bucket: number, shard: number): string {
    return `${negBucketPrefix(snapshotDate, bucket)}/shard-${pad3(shard)}.bin`;
}

export function negManifestKeyFor(snapshotDate: string, bucket: number): string {
    return `${negBucketPrefix(snapshotDate, bucket)}/manifest.json`;
}
