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
        throw new Error(`R2 object not found: ${key}`);
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
        throw new Error(`R2 object disappeared between head() and get(): ${key}`);
    }
    if (obj.etag !== etag) {
        throw new Error(`R2 etag drifted mid-fetch for ${key} (head=${etag}, get=${obj.etag}). Refusing to cache.`);
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());

    if (bytes.length !== expectedSize) {
        throw new Error(
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
