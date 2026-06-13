/**
 * Xref-index loader — PR-COMPOUND-GUARD (Step-5a).
 *
 * Loads `snapshots/<date>/xref-index.json.gz` (gzipped by snapshot-builder)
 * and exposes ONE per-kind Map at a time for O(1) non-CID identifier ->
 * CID lookup. Mirrors compound-manifest-loader.ts (per-isolate Map cache +
 * caches.default 24h immutable, keyed by snapshot_date).
 *
 * WHY per-KIND lazy: the index partitions all 7 non-CID id kinds in ONE file,
 * but the worker only ever needs the Map for the SINGLE kind it is resolving.
 * Loading just that kind's Map keeps peak memory at ~one ~130K-entry Map
 * (~10-15MB), safe inside the 128MB isolate — vs the whole-file gunzip scan
 * (entity-resolver.ts pre-Step-5a) that re-OOMs once the FDA uncap grows the
 * compound record. The whole gzip is fetched once (it carries all 7 kinds),
 * but only the queried kind is materialized into a Map.
 *
 * MAX_XREF_ENTRIES per-kind throw + an XREF_MAX_BYTES head().size guard mirror
 * the manifest loader's OOM-prevention contract (Gemini review #1 analog).
 */

import { fetchR2GunzippedText } from './r2-fetch';
import { type SnapshotContext, snapshotIdentityToken } from './snapshot-context';

export type XrefKind =
    | 'chembl_id'
    | 'inchi_key'
    | 'unii'
    | 'drugbank_id'
    | 'chebi_id'
    | 'kegg_drug_id'
    | 'rxcui';

// Per-kind hard cap. Beyond this a single kind's Map would risk the 128MB
// isolate budget; throw LOUD (mirrors compound-manifest-loader MAX_MANIFEST_ENTRIES).
export const MAX_XREF_ENTRIES = 500_000;

// Refuse to gunzip an xref-index whose COMPRESSED object exceeds this (LOUD
// throw, never OOM). The file carries all 7 kinds so it is larger than any
// single per-kind manifest; 64MB compressed is comfortably above the expected
// size (~130K compounds * 7 kinds of short id strings) yet below a runaway.
export const XREF_MAX_BYTES = 64 * 1024 * 1024;

export interface XrefIndexFile {
    version: string;
    snapshot_date: string;
    generated_at: string;
    total_compounds: number;
    index: Partial<Record<XrefKind, Record<string, number>>>;
}

// Per-isolate cache keyed by (snapshotDate, kind) -> the materialized Map.
const ISOLATE_CACHE = new Map<string, Map<string, number>>();
const MAX_CACHE_ENTRIES = 8; // up to 7 kinds for the latest snapshot + slack

// Cloudflare Cache API: the whole gzip is immutable per snapshot date, so a
// 24h TTL is safe. Keyed by snapshot_date only (shared across kinds + isolates).
const CACHE_API_TTL_SECONDS = 24 * 60 * 60;

function pruneCache() {
    while (ISOLATE_CACHE.size > MAX_CACHE_ENTRIES) {
        const k = ISOLATE_CACHE.keys().next().value;
        if (k === undefined) break;
        ISOLATE_CACHE.delete(k);
    }
}

export function xrefIndexKey(snapshotDate: string): string {
    return `snapshots/${snapshotDate}/xref-index.json.gz`;
}

/**
 * RK-15 PR-A — context-aware xref-index key. v2 reads the DECLARED xref_index_key;
 * v1 derives it from the pinned date. NEVER reconstructs a v2 path from a date.
 */
export function xrefIndexKeyForCtx(ctx: SnapshotContext): string {
    if (ctx.layout_version === 'immutable_snapshot_v2') {
        if (!ctx.xref_index_key) {
            throw new Error('immutable_snapshot_v2 context lacks xref_index_key');
        }
        return ctx.xref_index_key;
    }
    return xrefIndexKey(ctx.snapshot_date);
}

/**
 * Does the xref-index projection exist for this snapshot? A head() probe the
 * resolver uses to choose the index path vs the deploy-transition fallback
 * (whole-file scan) when the projection is absent (404). Uses the pinned ctx.
 */
export async function xrefIndexExists(bucket: R2Bucket, ctx: SnapshotContext): Promise<boolean> {
    // v2 with no declared xref_index_key -> there is no projection to probe.
    if (ctx.layout_version === 'immutable_snapshot_v2' && !ctx.xref_index_key) {
        return false;
    }
    const head = await bucket.head(xrefIndexKeyForCtx(ctx));
    return head != null;
}

/**
 * Load (and cache) the per-kind Map for `kind` at `snapshotDate`.
 *
 * Throws if the index object exceeds XREF_MAX_BYTES (head().size guard) or if
 * the queried kind's entry count exceeds MAX_XREF_ENTRIES. Returns an empty Map
 * when the kind is simply absent from the index (no entries of that kind).
 */
export async function loadXrefKind(
    bucket: R2Bucket,
    ctx: SnapshotContext,
    kind: XrefKind,
): Promise<Map<string, number>> {
    const identity = snapshotIdentityToken(ctx);
    const key = xrefIndexKeyForCtx(ctx);
    const cacheKey = `xref:${identity}:${kind}`;
    const cached = ISOLATE_CACHE.get(cacheKey);
    if (cached) return cached;

    // head().size OOM guard BEFORE the gunzip (mirror neg-evidence-loader
    // LEGACY_MAX_BYTES). A missing object surfaces as a thrown error -> the
    // resolver decides fallback via xrefIndexExists() before calling here.
    const head = await bucket.head(key);
    if (!head) throw new Error(`Xref-index not found: ${key}`);
    if (head.size > XREF_MAX_BYTES) {
        throw new Error(`Xref-index ${key} is ${head.size} bytes (> ${XREF_MAX_BYTES}); refusing to load (OOM guard).`);
    }

    // Fetch the whole gzip ONCE (it carries all 7 kinds). Cache API stores the
    // decompressed JSON text keyed by the snapshot IDENTITY (+ the object key) so
    // a stale colo entry can never be served for a different snapshot.
    const cacheApiUrl =
        `https://xref-cache.sciweon.internal/${encodeURIComponent(identity)}/${encodeURIComponent(key)}`;
    const cacheApiReq = new Request(cacheApiUrl);
    const cacheApiHit = await caches.default.match(cacheApiReq);
    let text: string;
    if (cacheApiHit) {
        text = await cacheApiHit.text();
    } else {
        text = await fetchR2GunzippedText(bucket, key);
        const resp = new Response(text, {
            headers: {
                'content-type': 'application/json',
                'cache-control': `public, max-age=${CACHE_API_TTL_SECONDS}, immutable`,
            },
        });
        await caches.default.put(cacheApiReq, resp);
    }

    const parsed = JSON.parse(text) as XrefIndexFile;
    const kindObj = parsed.index?.[kind] ?? {};
    const entries = Object.keys(kindObj);
    if (entries.length > MAX_XREF_ENTRIES) {
        throw new Error(
            `Xref-index kind '${kind}' has ${entries.length} entries (> ${MAX_XREF_ENTRIES}); ` +
            `I-8 WASM SQLite migration required.`,
        );
    }

    const map = new Map<string, number>();
    for (const norm of entries) {
        const cid = kindObj[norm];
        if (typeof cid === 'number' && Number.isInteger(cid)) map.set(norm, cid);
    }
    ISOLATE_CACHE.set(cacheKey, map);
    pruneCache();
    return map;
}
