/**
 * RK-16A2 — flat -> two-level posting decision (PURE MECHANISM).
 *
 * A posting list for an index key is stored FLAT (an inline PostingPageRef[])
 * until it gets too big, at which point it becomes TWO-LEVEL: the page refs are
 * written as ONE directory NXVF entity and referenced by a PostingDirectoryRef.
 *
 * Two-level is MANDATORY when EITHER:
 *   - the page-ref count > per_key_inline_pageref_cap (64), OR
 *   - the serialized inline representation > inline_manifest_bytes_ceiling (1 MiB).
 *
 * directory_depth is EXACTLY 1 (a directory holds page refs, never another
 * directory). OFFLINE/FIXTURE use only.
 */

export const PER_KEY_INLINE_PAGEREF_CAP = 64;
export const INLINE_MANIFEST_BYTES_CEILING = 1024 * 1024; // 1 MiB
export const DIRECTORY_DEPTH = 1;

/**
 * @param {object[]} pageRefs  the PostingPageRef[] for one index key
 * @returns {{
 *   two_level:boolean, directory_depth:number, page_ref_count:number,
 *   inline_bytes:number, reason:('count'|'bytes'|null)
 * }}
 */
export function decide(pageRefs) {
    const page_ref_count = pageRefs.length;
    const inline_bytes = Buffer.byteLength(JSON.stringify(pageRefs), 'utf-8');

    const overCount = page_ref_count > PER_KEY_INLINE_PAGEREF_CAP;
    const overBytes = inline_bytes > INLINE_MANIFEST_BYTES_CEILING;
    const two_level = overCount || overBytes;

    return {
        two_level,
        directory_depth: two_level ? DIRECTORY_DEPTH : 0,
        page_ref_count,
        inline_bytes,
        reason: overCount ? 'count' : overBytes ? 'bytes' : null,
    };
}
