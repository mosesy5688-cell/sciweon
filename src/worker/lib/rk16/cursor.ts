/**
 * RK-16A1 — cursor encode/decode/revalidate (PURE MECHANISM).
 *
 * A pagination cursor is a CLIENT-UNTRUSTED, FULLY-REVALIDATED, snapshot-bound,
 * filter-bound token. It is base64url of CANONICAL JSON (recursively sorted
 * keys — byte-identical to scripts/factory/lib/snapshot-identity.js canonicalize)
 * so encoding is deterministic and a round-trip is stable.
 *
 * UNSIGNED in A1. There is NO HMAC and NO encryption here. CONSEQUENTLY the
 * descriptor adjectives "opaque" / "non-replayable" / "tamper-proof" DO NOT
 * apply to this unsigned cursor: a client can read and forge it. That is
 * tolerated ONLY because the cursor is internal/shadow and EVERY field is
 * re-validated on decode against the live snapshot/family/filter — a forged or
 * stale value is rejected, never trusted, never silently clamped. Adding an HMAC
 * is a PRECONDITION of the (separate, NOT-in-A1) public pagination cutover; until
 * then this cursor must not be exposed as a public, replay-safe token.
 *
 * Cursor errors are CLIENT/STATE errors, never storage faults: InvalidCursor=400,
 * FilterMismatch=400, StaleCursor=409. They are deliberately NOT mapped to 5xx
 * (5xx is reserved for storage/source faults — see source-load-error.ts).
 */

export const CURSOR_VERSION = 1;

export interface CursorPayload {
    readonly cursor_version: number;
    readonly snapshot_identity: string;
    readonly family: string;
    readonly index_key: string;
    readonly partition: string;
    readonly page_ordinal: number;
    readonly in_page_offset: number;
    readonly filter_fingerprint: string;
}

/** Context the live request supplies to re-check EVERY cursor field. */
export interface CursorRevalidationContext {
    readonly activeSnapshotIdentity: string;
    readonly family: string;
    readonly activeFilterFingerprint: string;
    readonly pageTotalForKey: number;
    readonly recordCountForPage: number;
}

// ── Typed errors (each maps to a deliberate non-5xx status) ──────────────────

export class InvalidCursorError extends Error {
    readonly httpStatus = 400;
    constructor(reason: string) {
        super(`Invalid cursor: ${reason}`);
        this.name = 'InvalidCursorError';
    }
}
export class FilterMismatchError extends Error {
    readonly httpStatus = 400;
    constructor(reason: string) {
        super(`Cursor filter mismatch: ${reason}`);
        this.name = 'FilterMismatchError';
    }
}
export class StaleCursorError extends Error {
    readonly httpStatus = 409;
    constructor(reason: string) {
        super(`Stale cursor: ${reason}`);
        this.name = 'StaleCursorError';
    }
}

/**
 * Canonical JSON: recursively sort object keys (arrays keep order), compact
 * separators, primitives via JSON.stringify. Byte-identical to the producer's
 * canonicalize so the same payload always encodes to the same string.
 */
export function canonicalize(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        const body = keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',');
        return `{${body}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function toBase64Url(s: string): string {
    // UTF-8 -> base64 -> url-safe (no padding). btoa needs a binary string.
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

function isInt(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v);
}
function isStr(v: unknown): v is string {
    return typeof v === 'string';
}

/** Encode a payload to a canonical, stable base64url cursor string. */
export function encode(payload: CursorPayload): string {
    return toBase64Url(canonicalize(payload as unknown));
}

/**
 * Decode a cursor string to a payload, validating SHAPE only (field presence +
 * types + cursor_version). State checks (snapshot/filter/range) are revalidate's
 * job. Throws InvalidCursorError on any malformed/forged-shape input.
 */
export function decode(str: string): CursorPayload {
    if (typeof str !== 'string' || str.length === 0) {
        throw new InvalidCursorError('empty cursor');
    }
    let raw: string;
    try {
        raw = fromBase64Url(str);
    } catch {
        throw new InvalidCursorError('not valid base64url');
    }
    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        throw new InvalidCursorError('decoded payload is not JSON');
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        throw new InvalidCursorError('payload is not an object');
    }
    const o = obj as Record<string, unknown>;
    if (o.cursor_version !== CURSOR_VERSION) {
        throw new InvalidCursorError(`unsupported cursor_version ${String(o.cursor_version)}`);
    }
    if (!isStr(o.snapshot_identity) || !isStr(o.family) || !isStr(o.index_key)
        || !isStr(o.partition) || !isStr(o.filter_fingerprint)) {
        throw new InvalidCursorError('missing/invalid string field');
    }
    if (!isInt(o.page_ordinal) || !isInt(o.in_page_offset)) {
        throw new InvalidCursorError('page_ordinal/in_page_offset must be integers');
    }
    return {
        cursor_version: o.cursor_version,
        snapshot_identity: o.snapshot_identity,
        family: o.family,
        index_key: o.index_key,
        partition: o.partition,
        page_ordinal: o.page_ordinal,
        in_page_offset: o.in_page_offset,
        filter_fingerprint: o.filter_fingerprint,
    };
}

/**
 * Re-check EVERY field of a decoded payload against the live request context.
 * NEVER silently clamps an out-of-range ordinal/offset — it throws. Order:
 *   snapshot drift -> StaleCursorError(409)
 *   family/index_key unresolvable -> InvalidCursorError(400)
 *   filter drift -> FilterMismatchError(400)
 *   range violations -> InvalidCursorError(400)
 */
export function revalidateCursor(
    payload: CursorPayload,
    ctx: CursorRevalidationContext,
): CursorPayload {
    if (payload.snapshot_identity !== ctx.activeSnapshotIdentity) {
        throw new StaleCursorError(
            `snapshot ${payload.snapshot_identity} != active ${ctx.activeSnapshotIdentity}`,
        );
    }
    if (payload.family !== ctx.family) {
        throw new InvalidCursorError(`family ${payload.family} unresolvable (active ${ctx.family})`);
    }
    if (payload.index_key.length === 0) {
        throw new InvalidCursorError('index_key is empty (unresolvable)');
    }
    if (payload.filter_fingerprint !== ctx.activeFilterFingerprint) {
        throw new FilterMismatchError(
            `filter ${payload.filter_fingerprint} != active ${ctx.activeFilterFingerprint}`,
        );
    }
    if (payload.page_ordinal < 0 || payload.page_ordinal >= ctx.pageTotalForKey) {
        throw new InvalidCursorError(
            `page_ordinal ${payload.page_ordinal} out of [0, ${ctx.pageTotalForKey})`,
        );
    }
    if (payload.in_page_offset < 0 || payload.in_page_offset >= ctx.recordCountForPage) {
        throw new InvalidCursorError(
            `in_page_offset ${payload.in_page_offset} out of [0, ${ctx.recordCountForPage})`,
        );
    }
    return payload;
}
