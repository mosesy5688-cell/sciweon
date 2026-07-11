/**
 * RC-3B-P0B -- object-format policy (PURE, no network).
 *
 * Decides, BEFORE any network call, whether an object key is:
 *   - structural  (small metadata: manifest / seal / index / cursor JSON) --
 *     eligible for a bounded structural GET-META (no Range) after HEAD proves
 *     it is small; and
 *   - payload     (bulk content: *.jsonl(.gz), monolithic dumps) -- a GET with
 *     NO Range on a payload key FAILS BEFORE NETWORK; and
 *   - range-target class: only an NXVF / locator-addressed shard may be
 *     Range-read. A monolithic gzip (.gz) or zstd (.zst/.zstd) object is NOT
 *     seekable at a meaningful record boundary, so a Range read of it is
 *     rejected BEFORE NETWORK (no arbitrary gzip/zstd middle decode).
 *
 * Format magic (reference only -- classification here is by declared class +
 * key suffix, decided pre-network): NXVF = 4E 58 56 46 ("NXVF");
 * gzip = 1F 8B; zstd = 28 B5 2F FD.
 */

export const NXVF_MAGIC = Object.freeze([0x4e, 0x58, 0x56, 0x46]);
export const GZIP_MAGIC = Object.freeze([0x1f, 0x8b]);
export const ZSTD_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd]);

// Object classes the run plan may declare. Only NXVF_SHARD is range-readable.
export const OBJECT_CLASSES = Object.freeze([
    'STRUCTURAL_JSON',   // small metadata JSON (manifest/seal/index/cursor)
    'NXVF_SHARD',        // locator-addressed binary shard (Range-readable)
    'MONOLITHIC_GZIP',   // whole-object gzip -- NOT range-readable
    'MONOLITHIC_ZSTD',   // whole-object zstd -- NOT range-readable
    'PAYLOAD_JSONL',     // bulk JSONL payload -- NOT structural, NOT range-readable
]);

const STRUCTURAL_SUFFIXES = ['.json', '.manifest.json', '_manifest.json'];
const MONO_GZIP_SUFFIXES = ['.gz', '.gzip'];
const MONO_ZSTD_SUFFIXES = ['.zst', '.zstd'];
const NXVF_SUFFIXES = ['.bin'];

function endsWithAny(key, suffixes) {
    const k = String(key).toLowerCase();
    return suffixes.some((s) => k.endsWith(s));
}

/**
 * Infer a class from the key suffix. Used to CROSS-CHECK the declared class:
 * if a plan declares NXVF_SHARD for a `.gz` key the two disagree and the range
 * read is refused. A `.jsonl.gz` counts as monolithic gzip (payload), never
 * structural.
 */
export function inferClassFromKey(key) {
    if (endsWithAny(key, NXVF_SUFFIXES)) return 'NXVF_SHARD';
    if (endsWithAny(key, MONO_ZSTD_SUFFIXES)) return 'MONOLITHIC_ZSTD';
    if (endsWithAny(key, MONO_GZIP_SUFFIXES)) return 'MONOLITHIC_GZIP';
    if (endsWithAny(key, STRUCTURAL_SUFFIXES)) return 'STRUCTURAL_JSON';
    return 'PAYLOAD_JSONL';
}

/** True only for classes eligible for a bounded structural GET-META (no Range). */
export function isStructuralClass(cls) {
    return cls === 'STRUCTURAL_JSON';
}

/** True for bulk/payload classes: a no-Range GET on these fails before network. */
export function isPayloadClass(cls) {
    return cls === 'PAYLOAD_JSONL' || cls === 'MONOLITHIC_GZIP' || cls === 'MONOLITHIC_ZSTD';
}

/** True only for the one Range-readable, locator-addressed class. */
export function isRangeReadableClass(cls) {
    return cls === 'NXVF_SHARD';
}

/**
 * Decide whether a Range read of `key` (declared as `declaredClass`) is
 * permitted. It is permitted ONLY when BOTH the declared class AND the
 * key-suffix inference say NXVF_SHARD. Any monolithic gzip/zstd (by declaration
 * OR by suffix) is refused. Returns { ok, reason, effectiveClass }.
 */
export function classifyRangeTarget(key, declaredClass) {
    const inferred = inferClassFromKey(key);
    if (!OBJECT_CLASSES.includes(declaredClass)) {
        return { ok: false, reason: `unknown declared class ${declaredClass}`, effectiveClass: inferred };
    }
    if (declaredClass === 'MONOLITHIC_GZIP' || inferred === 'MONOLITHIC_GZIP') {
        return { ok: false, reason: 'monolithic gzip is not seekable -- no arbitrary gzip middle decode', effectiveClass: 'MONOLITHIC_GZIP' };
    }
    if (declaredClass === 'MONOLITHIC_ZSTD' || inferred === 'MONOLITHIC_ZSTD') {
        return { ok: false, reason: 'monolithic zstd is not seekable -- no arbitrary zstd middle decode', effectiveClass: 'MONOLITHIC_ZSTD' };
    }
    if (declaredClass !== 'NXVF_SHARD' || inferred !== 'NXVF_SHARD') {
        return { ok: false, reason: `range read requires NXVF_SHARD (declared=${declaredClass}, inferred=${inferred})`, effectiveClass: inferred };
    }
    return { ok: true, reason: 'nxvf locator-bound range', effectiveClass: 'NXVF_SHARD' };
}
