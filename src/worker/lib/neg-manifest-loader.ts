/**
 * NegEvidence per-bucket manifest loader — mirrors compound-manifest-loader.ts
 * but PER-BUCKET. The worker computes bucket = negBucketOf(key), then loads
 * ONLY that one bucket's manifest (a small object holding the ~36 keys that
 * hash to it, NOT a global 37k-key manifest). Resident manifest memory is
 * therefore bounded to the queried buckets, not the whole corpus.
 *
 * Three cache tiers, identical to the compound path:
 *   1. per-isolate Map (ISOLATE_CACHE)
 *   2. Cloudflare Cache API (shared across isolates on a colo, 24h immutable)
 *   3. R2 GET of the bucket manifest
 */

import { fetchR2JsonText } from './r2-fetch';
import { negManifestKeyFor } from './neg-shard-router';

// Mirror of the compound loader's cap idea. Per-bucket manifests are tiny
// (~36 entries at 37k keys / 1024 buckets), but the cap is a tripwire: if a
// single bucket ever exceeds this, the partition is pathologically skewed and
// we must surface it (LOUD) rather than silently load a giant object.
export const MAX_MANIFEST_ENTRIES = 50_000;

export interface NegPageRef {
    offset: number;
    size: number;
    count: number;
    shard: number;
}

export interface NegManifestEntry {
    key: string;
    shard: number;
    total: number;
    // 4 ints: [critical, major, minor, unknown] — UNFILTERED over the whole key.
    severity_rollup: [number, number, number, number];
    // <=7 ints keyed by evidence_type — UNFILTERED over the whole key.
    type_rollup: Record<string, number>;
    // Cross-tab {evidence_type -> [critical, major, minor, unknown]} (<=7 x 4
    // ints). The worker serves an event_type-filtered request EXACTLY from this:
    // filtered total = sum of type_rollup[t]; filtered signals_by_severity =
    // element-wise sum of sev_by_type[t]; both O(1) from the manifest, no scan.
    // Optional for backward-compat with manifests published before this field.
    sev_by_type?: Record<string, [number, number, number, number]>;
    pages: NegPageRef[];
}

export interface NegShardHash {
    shard: number;
    filename: string;
    sha256: string;
    size_bytes: number;
}

export interface NegManifestIndexes {
    bucket: number;
    snapshot_date: string;
    byKey: Map<string, NegManifestEntry>;
    shardHashes: NegShardHash[];
}

interface RawNegManifest {
    version: string;
    bucket: number;
    snapshot_date: string;
    generated_at: string;
    total_records: number;
    shard_count: number;
    entries: NegManifestEntry[];
    shard_hashes: NegShardHash[];
}

const ISOLATE_CACHE = new Map<string, NegManifestIndexes>();
// Bounded by the number of distinct buckets queried within one isolate's life.
// 64 covers a healthy fan-out without unbounded growth.
const MAX_CACHE_ENTRIES = 64;
const CACHE_API_TTL_SECONDS = 24 * 60 * 60;

function pruneCache(): void {
    while (ISOLATE_CACHE.size > MAX_CACHE_ENTRIES) {
        const k = ISOLATE_CACHE.keys().next().value;
        if (k === undefined) break;
        ISOLATE_CACHE.delete(k);
    }
}

export async function loadNegBucketManifest(
    bucket: R2Bucket,
    bucketIndex: number,
    snapshotDate: string,
): Promise<NegManifestIndexes> {
    const cacheKey = `neg-manifest:${snapshotDate}:${bucketIndex}`;

    const cached = ISOLATE_CACHE.get(cacheKey);
    if (cached) return cached;

    const cacheApiUrl = `https://neg-manifest-cache.sciweon.internal/${snapshotDate}/${bucketIndex}`;
    const cacheApiReq = new Request(cacheApiUrl);
    const cacheApiHit = await caches.default.match(cacheApiReq);
    let text: string;
    if (cacheApiHit) {
        text = await cacheApiHit.text();
    } else {
        const key = negManifestKeyFor(snapshotDate, bucketIndex);
        text = await fetchR2JsonText(bucket, key);
        const cacheResp = new Response(text, {
            headers: {
                'content-type': 'application/json',
                'cache-control': `public, max-age=${CACHE_API_TTL_SECONDS}, immutable`,
            },
        });
        await caches.default.put(cacheApiReq, cacheResp);
    }
    const manifest = JSON.parse(text) as RawNegManifest;

    if (manifest.entries.length > MAX_MANIFEST_ENTRIES) {
        throw new Error(
            `Neg bucket manifest ${bucketIndex} size ${manifest.entries.length} exceeds cap ${MAX_MANIFEST_ENTRIES} ` +
            `— pathological partition skew, refusing to load.`,
        );
    }

    const byKey = new Map<string, NegManifestEntry>();
    for (const e of manifest.entries) {
        byKey.set(e.key, e);
    }
    const indexes: NegManifestIndexes = {
        bucket: manifest.bucket,
        snapshot_date: manifest.snapshot_date,
        byKey,
        shardHashes: manifest.shard_hashes,
    };
    ISOLATE_CACHE.set(cacheKey, indexes);
    pruneCache();
    return indexes;
}
