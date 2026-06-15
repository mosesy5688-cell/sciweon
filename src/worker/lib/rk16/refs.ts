/**
 * RK-16A1 — contract reference primitives (PURE MECHANISM).
 *
 * The FOUR reference types the substrate contract names, made mutually
 * NON-INTERCHANGEABLE. Each carries a `kind` discriminant AND a TS brand so the
 * compiler refuses to pass one where another is expected; runtime type guards
 * give the same guarantee at the boundary (untrusted / deserialized refs).
 *
 * Substrate-only: this models the SHAPE + the one structural contract rule
 * ("a posting list never points at a canonical page"). It performs NO I/O, holds
 * NO business policy (no papers/bioactivities/repurposing semantics), and is NOT
 * imported by the live worker in A1.
 *
 * THE contract rule encoded here:
 *   A posting list (an index key's hit list) may hold ONLY a PostingPageRef or a
 *   PostingDirectoryRef — NEVER a CanonicalPageRef or a RecordLocator. A posting
 *   entry points at a PROJECTION page (filterable, cursor-bounded), and the
 *   projection row carries the RecordLocator that reaches the canonical record.
 *   Letting a posting list point straight at a canonical page would collapse the
 *   projection/canonical separation and break filtered pagination.
 */

declare const REF_BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [REF_BRAND]: B };

/** Locates ONE canonical record inside a shard by byte range + integrity hash. */
export type RecordLocator = Brand<{
    readonly kind: 'record_locator';
    readonly shard_key: string;
    readonly byte_offset: number;
    readonly byte_length: number;
    readonly canonical_id: string;
    readonly content_hash: string;
}, 'record_locator'>;

/** A page of CANONICAL records (the source-of-truth bytes), addressed by range. */
export type CanonicalPageRef = Brand<{
    readonly kind: 'canonical_page_ref';
    readonly shard_key: string;
    readonly page_offset: number;
    readonly page_length: number;
    readonly record_count: number;
    readonly content_hash: string;
}, 'canonical_page_ref'>;

/** A page of a POSTING list (projection rows for one index key), cursor-bounded. */
export type PostingPageRef = Brand<{
    readonly kind: 'posting_page_ref';
    readonly shard_key: string;
    readonly page_offset: number;
    readonly page_length: number;
    readonly record_count: number;
    readonly cursor_min: string;
    readonly cursor_max: string;
    readonly page_sha256: string;
}, 'posting_page_ref'>;

/** A directory of PostingPageRefs (the control layer for a large posting list). */
export type PostingDirectoryRef = Brand<{
    readonly kind: 'posting_directory_ref';
    readonly directory_shard_key: string;
    readonly directory_offset: number;
    readonly directory_length: number;
    readonly page_ref_count: number;
    readonly directory_sha256: string;
}, 'posting_directory_ref'>;

/** Any of the four contract refs (a discriminated union over `kind`). */
export type ContractRef =
    | RecordLocator
    | CanonicalPageRef
    | PostingPageRef
    | PostingDirectoryRef;

/** A posting list may ONLY hold these two. */
export type PostingListEntry = PostingPageRef | PostingDirectoryRef;

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}
function isStr(v: unknown): v is string {
    return typeof v === 'string';
}
function isNum(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

// ── Runtime type guards (boundary guarantee for untrusted/deserialized refs) ──

export function isRecordLocator(v: unknown): v is RecordLocator {
    return isObj(v) && v.kind === 'record_locator'
        && isStr(v.shard_key) && isNum(v.byte_offset) && isNum(v.byte_length)
        && isStr(v.canonical_id) && isStr(v.content_hash);
}

export function isCanonicalPageRef(v: unknown): v is CanonicalPageRef {
    return isObj(v) && v.kind === 'canonical_page_ref'
        && isStr(v.shard_key) && isNum(v.page_offset) && isNum(v.page_length)
        && isNum(v.record_count) && isStr(v.content_hash);
}

export function isPostingPageRef(v: unknown): v is PostingPageRef {
    return isObj(v) && v.kind === 'posting_page_ref'
        && isStr(v.shard_key) && isNum(v.page_offset) && isNum(v.page_length)
        && isNum(v.record_count) && isStr(v.cursor_min) && isStr(v.cursor_max)
        && isStr(v.page_sha256);
}

export function isPostingDirectoryRef(v: unknown): v is PostingDirectoryRef {
    return isObj(v) && v.kind === 'posting_directory_ref'
        && isStr(v.directory_shard_key) && isNum(v.directory_offset)
        && isNum(v.directory_length) && isNum(v.page_ref_count)
        && isStr(v.directory_sha256);
}

export function isPostingListEntry(v: unknown): v is PostingListEntry {
    return isPostingPageRef(v) || isPostingDirectoryRef(v);
}

/**
 * Thrown when a posting list entry would point at a canonical page / record —
 * a structural contract violation. Typed (not a bare Error) so a future caller
 * can map it deliberately (it is an internal invariant breach, not a 4xx/5xx
 * surfaced to clients in A1; A1 only asserts the mechanism).
 */
export class PostingTargetContractError extends Error {
    readonly observed_kind: string;
    constructor(observedKind: string) {
        super(
            `Posting list entry must be a posting_page_ref|posting_directory_ref, ` +
            `got "${observedKind}" — a posting list never points at a canonical page.`,
        );
        this.name = 'PostingTargetContractError';
        this.observed_kind = observedKind;
    }
}

/**
 * Assert a value is a legal posting-list entry. THROWS PostingTargetContractError
 * for a CanonicalPageRef / RecordLocator (or any non-posting value). Narrows to
 * PostingListEntry on success. This is THE encoded rule "a posting list never
 * points at a canonical page."
 */
export function assertPostingTargetsProjectionNotCanonical(
    ref: unknown,
): asserts ref is PostingListEntry {
    if (isPostingListEntry(ref)) return;
    const kind = isObj(ref) && isStr(ref.kind) ? ref.kind : typeof ref;
    throw new PostingTargetContractError(kind);
}
