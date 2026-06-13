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

import type { SnapshotContext } from './snapshot-context';

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

/**
 * RK-15 PR-A — context-aware neg-evidence key derivation.
 *
 * legacy_v1: date-derived (the v1 contract, unchanged).
 * immutable_snapshot_v2: derived RELATIVE to the declared neg_evidence_manifest_key
 *   prefix (the `.../neg-evidence/` root) — NEVER reassembled from a date.
 */
function v2NegRoot(ctx: SnapshotContext): string {
    const key = ctx.neg_evidence_manifest_key;
    if (!key) {
        throw new Error('immutable_snapshot_v2 context lacks neg_evidence_manifest_key');
    }
    const marker = '/neg-evidence/';
    const i = key.indexOf(marker);
    if (i < 0) {
        throw new Error(`v2 neg_evidence_manifest_key has no /neg-evidence/ segment: ${key}`);
    }
    return key.slice(0, i + marker.length); // ends with `neg-evidence/`
}

export function negBucketPrefixForCtx(ctx: SnapshotContext, bucket: number): string {
    if (ctx.layout_version === 'immutable_snapshot_v2') {
        return `${v2NegRoot(ctx)}bucket-${pad4(bucket)}`;
    }
    return negBucketPrefix(ctx.snapshot_date, bucket);
}

export function negShardKeyForCtx(ctx: SnapshotContext, bucket: number, shard: number): string {
    return `${negBucketPrefixForCtx(ctx, bucket)}/shard-${pad3(shard)}.bin`;
}

export function negManifestKeyForCtx(ctx: SnapshotContext, bucket: number): string {
    return `${negBucketPrefixForCtx(ctx, bucket)}/manifest.json`;
}
