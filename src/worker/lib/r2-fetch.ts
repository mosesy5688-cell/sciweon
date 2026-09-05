/**
 * R2 object fetcher with chunk-size validation.
 *
 * Why this matters: when an R2 binding returns an object with a partial
 * body (rare, but possible during edge-side transient pressure), the
 * fetched bytes can be SHORTER than the object's actual size while the
 * HTTP layer still reports 200 OK. Caching that short body poisons all
 * subsequent isolates until cache eviction.
 *
 * Defense: validate body length against expected size BEFORE any caching.
 * This file embeds the check from line one so it cannot be forgotten.
 *
 * Snapshot files (`snapshots/<date>/*.gz`) are immutable once published;
 * we cache the full decompressed contents per isolate keyed by (key, etag).
 * If the validation rejects a fetch, the caller surfaces the error rather
 * than serving zero-padded garbage.
 */

/**
 * Structural discriminant for every read fault this module raises. Rule 4c.1:
 * the class is decided HERE, at the throw site, by type - consumers dispatch
 * on `discriminant` and never on the message text.
 */
export type R2ReadDiscriminant =
    | 'not_found'
    | 'disappeared'
    | 'etag_drift'
    | 'short_read'
    | 'range_failed'
    | 'short_range_read';

/**
 * Typed R2 read failure. It extends Error and preserves the exact message
 * text each site raised before it was typed, so every one of this module's
 * importers that merely propagates the error is behaviourally unchanged:
 * `instanceof Error` and `.message` are both preserved. Only the consumers
 * that used to sniff the message read `discriminant`.
 */
export class R2ReadError extends Error {
    readonly discriminant: R2ReadDiscriminant;

    constructor(discriminant: R2ReadDiscriminant, message: string) {
        super(message);
        this.name = 'R2ReadError';
        this.discriminant = discriminant;
    }
}

interface R2FetchResult {
    bytes: Uint8Array;
    etag: string;
}

const CACHE = new Map<string, R2FetchResult>();
const MAX_CACHE_ENTRIES = 16;

function pruneCache() {
    while (CACHE.size > MAX_CACHE_ENTRIES) {
        const oldestKey = CACHE.keys().next().value;
        if (oldestKey === undefined) break;
        CACHE.delete(oldestKey);
    }
}

export async function fetchR2Object(bucket: R2Bucket, key: string): Promise<R2FetchResult> {
    // Head first so we know the expected size BEFORE downloading.
    // This is the V27.5 lesson: never trust a 200 OK alone — verify
    // the body length matches what the object metadata claims.
    const head = await bucket.head(key);
    if (!head) {
        throw new R2ReadError('not_found', `R2 object not found: ${key}`);
    }
    const expectedSize = head.size;
    const etag = head.etag;

    const cacheKey = `${key}@${etag}`;
    const cached = CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const obj = await bucket.get(key);
    if (!obj) {
        throw new R2ReadError('disappeared', `R2 object disappeared between head() and get(): ${key}`);
    }
    if (obj.etag !== etag) {
        throw new R2ReadError('etag_drift', `R2 etag drifted mid-fetch for ${key} (head=${etag}, get=${obj.etag}). Refusing to cache.`);
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());

    if (bytes.length !== expectedSize) {
        throw new R2ReadError(
            'short_read',
            `Short read on ${key}: got ${bytes.length} bytes, expected ${expectedSize} (etag=${etag}). Refusing to cache poisoned chunk.`
        );
    }

    const result: R2FetchResult = { bytes, etag };
    CACHE.set(cacheKey, result);
    pruneCache();
    return result;
}

export async function fetchR2GunzippedText(bucket: R2Bucket, key: string): Promise<string> {
    const { bytes } = await fetchR2Object(bucket, key);
    // Workers runtime: DecompressionStream is supported natively.
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const text = await new Response(stream).text();
    return text;
}

export async function fetchR2JsonText(bucket: R2Bucket, key: string): Promise<string> {
    const { bytes } = await fetchR2Object(bucket, key);
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Range-fetch raw bytes from an R2 object. Wave I-7a Phase 1 — workers
 * read a single record from a 10 MB shard via byte-range, avoiding the
 * full-bundle gunzip+scan that caused the 45K compound 1102 cliff.
 *
 * Cached per isolate keyed by (identity, key, offset, length). Cache eviction
 * is LRU at 16 entries (shared MAX_CACHE_ENTRIES). The (offset, length)
 * granularity means popular records share a cache slot even when accessed
 * from cold isolates that haven't yet fetched the full shard.
 *
 * RK-15 PR-A — IDENTITY BINDING: the cache key embeds the snapshot identity
 * token (v2: snapshot_id[+manifest_hash]; v1: date) IN ADDITION to the object
 * key. Even though shard object keys already differ across snapshots (v2 keys
 * carry the snapshot_id, v1 keys carry the date), binding the identity makes the
 * guarantee explicit and defends against any future key-collision: a stale
 * range-cache entry can NEVER return a different snapshot's shard bytes because
 * its cache key is namespaced by that snapshot's identity. After fetch, the
 * object's own ETag is verified against the prior cached ETag for the same
 * (identity, key, offset, length): an ETag mismatch refuses the cache reuse.
 */
export async function fetchR2RangeBytes(
    bucket: R2Bucket,
    key: string,
    offset: number,
    length: number,
    identity?: string,
): Promise<Uint8Array> {
    // identity-bound cache key: a missing identity falls back to the bare key
    // (back-compat for callers that have not yet threaded a SnapshotContext).
    const ns = identity ? `${identity}|` : '';
    const cacheKey = `range:${ns}${key}@${offset}+${length}`;
    const cached = CACHE.get(cacheKey);
    if (cached) return cached.bytes;

    const obj = await bucket.get(key, { range: { offset, length } });
    if (!obj) {
        throw new R2ReadError('range_failed', `R2 range fetch failed: ${key} [${offset}, +${length})`);
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.length !== length) {
        throw new R2ReadError(
            'short_range_read',
            `Short range read on ${key}@${offset}+${length}: got ${bytes.length} bytes. Refusing to cache.`
        );
    }
    const result: R2FetchResult = { bytes, etag: obj.etag };
    CACHE.set(cacheKey, result);
    pruneCache();
    return bytes;
}
