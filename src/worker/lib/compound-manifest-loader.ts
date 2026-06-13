/**
 * Compound manifest loader — Wave I-7a Phase 1.
 *
 * Loads `snapshots/<date>/compounds/bucket-NNNN/manifest.json` and builds
 * in-memory Maps for O(1) CID lookup. Per-isolate LRU cache (existing
 * pattern from r2-fetch.ts).
 *
 * Per Gemini review 2026-05-21 Concern #1 (Worker per-isolate 128MB OOM):
 * MAX_MANIFEST_ENTRIES = 500_000 hard cap. Beyond this, 5 Maps × ~200 bytes
 * overhead × N entries exceeds the 128MB Workers per-isolate budget. Throw
 * with explicit "I-8 WASM SQLite migration required" so capacity transition
 * is auto-detected vs human observation.
 */

import { fetchR2JsonText } from './r2-fetch';
import { manifestKeyForCtx } from './compound-bucket-router';
import { type SnapshotContext, snapshotIdentityToken } from './snapshot-context';

export const MAX_MANIFEST_ENTRIES = 500_000;

export interface ManifestEntry {
    cid: number;
    inchi_key: string | null;
    chembl_id: string | null;
    unii: string | null;
    drugbank_id: string | null;
    bucket: number;
    shard: number;
    offset: number;
    size: number;
}

export interface ShardHash {
    shard: number;
    filename: string;
    sha256: string;
    size_bytes: number;
}

export interface ManifestIndexes {
    byCid: Map<number, ManifestEntry>;
    byInchiKey: Map<string, ManifestEntry>;
    byChemblId: Map<string, ManifestEntry>;
    byUnii: Map<string, ManifestEntry>;
    byDrugbankId: Map<string, ManifestEntry>;
    shardHashes: ShardHash[];
}

interface RawManifest {
    version: string;
    bucket: number;
    snapshot_date: string;
    generated_at: string;
    total_records: number;
    shard_count: number;
    entries: ManifestEntry[];
    shard_hashes: ShardHash[];
}

const ISOLATE_CACHE = new Map<string, ManifestIndexes>();
const MAX_CACHE_ENTRIES = 4; // typically only 1-2 snapshots referenced per isolate lifetime

// Cloudflare Cache API key prefix — shared across all edge isolates (vs
// ISOLATE_CACHE which is per-isolate only). Manifest is immutable per
// snapshot date so 24h TTL is safe.
const CACHE_API_TTL_SECONDS = 24 * 60 * 60;

function pruneCache() {
    while (ISOLATE_CACHE.size > MAX_CACHE_ENTRIES) {
        const k = ISOLATE_CACHE.keys().next().value;
        if (k === undefined) break;
        ISOLATE_CACHE.delete(k);
    }
}

/**
 * RK-15 PR-A: cache keys are bound to the snapshot IDENTITY (v2: snapshot_id
 * [+manifest_hash]; v1: date), not the date alone, so a stale latest can never
 * cross-index a different snapshot's manifest. The object key is derived from
 * the pinned SnapshotContext (v2: declared key; v1: date-derived).
 */
export async function loadManifest(
    bucket: R2Bucket,
    bucketIndex: number,
    ctx: SnapshotContext,
): Promise<ManifestIndexes> {
    const identity = snapshotIdentityToken(ctx);
    const key = manifestKeyForCtx(ctx, bucketIndex);
    const cacheKey = `manifest:${identity}:${bucketIndex}`;

    // Tier 1: per-isolate Map cache (fastest, ~ns lookup)
    const cached = ISOLATE_CACHE.get(cacheKey);
    if (cached) return cached;

    // Tier 2: Cloudflare Cache API (shared across isolates on same colo,
    // 24h TTL since manifest is immutable per snapshot identity). Key embeds the
    // full identity token AND the object key so a stale colo entry from a
    // different snapshot can never be returned here.
    const cacheApiUrl =
        `https://manifest-cache.sciweon.internal/${encodeURIComponent(identity)}/${encodeURIComponent(key)}`;
    const cacheApiReq = new Request(cacheApiUrl);
    const cacheApiHit = await caches.default.match(cacheApiReq);
    let text: string;
    if (cacheApiHit) {
        text = await cacheApiHit.text();
    } else {
        // Tier 3: R2 GET (slowest, ~50-500ms for 50K-entry manifest)
        text = await fetchR2JsonText(bucket, key);
        // Populate Cache API for next request from any isolate
        const cacheResp = new Response(text, {
            headers: {
                'content-type': 'application/json',
                'cache-control': `public, max-age=${CACHE_API_TTL_SECONDS}, immutable`,
            },
        });
        await caches.default.put(cacheApiReq, cacheResp);
    }
    const manifest = JSON.parse(text) as RawManifest;

    // Gemini review #1: hard cap to prevent Worker OOM at 200K-300K (vs nominal 1M)
    if (manifest.entries.length > MAX_MANIFEST_ENTRIES) {
        throw new Error(
            `Manifest size ${manifest.entries.length} exceeds Phase 1 cap ${MAX_MANIFEST_ENTRIES}. ` +
            `I-8 WASM SQLite migration required.`
        );
    }

    const indexes: ManifestIndexes = {
        byCid: new Map(),
        byInchiKey: new Map(),
        byChemblId: new Map(),
        byUnii: new Map(),
        byDrugbankId: new Map(),
        shardHashes: manifest.shard_hashes,
    };
    for (const e of manifest.entries) {
        indexes.byCid.set(e.cid, e);
        if (e.inchi_key) indexes.byInchiKey.set(e.inchi_key, e);
        if (e.chembl_id) indexes.byChemblId.set(e.chembl_id, e);
        if (e.unii) indexes.byUnii.set(e.unii, e);
        if (e.drugbank_id) indexes.byDrugbankId.set(e.drugbank_id, e);
    }
    ISOLATE_CACHE.set(cacheKey, indexes);
    pruneCache();
    return indexes;
}
