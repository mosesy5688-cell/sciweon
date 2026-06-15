/**
 * RK-16A1 — cursor: stable canonical round-trip; full revalidation never silently
 * clamps; typed errors carry non-5xx statuses (400/400/409).
 */
import { describe, it, expect } from 'vitest';
import {
    encode, decode, revalidateCursor, canonicalize,
    InvalidCursorError, FilterMismatchError, StaleCursorError,
    CURSOR_VERSION,
    type CursorPayload, type CursorRevalidationContext,
} from '../../../src/worker/lib/rk16/cursor';

const payload: CursorPayload = {
    cursor_version: CURSOR_VERSION,
    snapshot_identity: 'legacy_v1:2026-06-12',
    family: 'fam',
    index_key: 'K1',
    partition: 'P0',
    page_ordinal: 2,
    in_page_offset: 3,
    filter_fingerprint: 'ff-abc',
};

const ctx: CursorRevalidationContext = {
    activeSnapshotIdentity: 'legacy_v1:2026-06-12',
    family: 'fam',
    activeFilterFingerprint: 'ff-abc',
    pageTotalForKey: 5,
    recordCountForPage: 10,
};

describe('RK-16A1 cursor — canonical round-trip is stable', () => {
    it('encode/decode preserves the payload', () => {
        expect(decode(encode(payload))).toEqual(payload);
    });

    it('encoding is canonical: field order in the source object does not matter', () => {
        const reordered = {
            filter_fingerprint: 'ff-abc', in_page_offset: 3, page_ordinal: 2,
            partition: 'P0', index_key: 'K1', family: 'fam',
            snapshot_identity: 'legacy_v1:2026-06-12', cursor_version: CURSOR_VERSION,
        } as CursorPayload;
        expect(encode(reordered)).toBe(encode(payload));
    });

    it('canonicalize sorts keys recursively', () => {
        expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    });
});

describe('RK-16A1 cursor — decode rejects malformed input', () => {
    it('non-base64url / non-JSON / wrong version -> InvalidCursorError', () => {
        expect(() => decode('')).toThrow(InvalidCursorError);
        expect(() => decode('!!!not-base64!!!')).toThrow(InvalidCursorError);
        const badVer = encode({ ...payload, cursor_version: 99 } as CursorPayload);
        expect(() => decode(badVer)).toThrow(InvalidCursorError);
    });
});

describe('RK-16A1 cursor — full revalidation, never silent clamp', () => {
    it('valid payload passes revalidation unchanged', () => {
        expect(revalidateCursor(payload, ctx)).toEqual(payload);
    });

    it('snapshot drift -> StaleCursorError (409)', () => {
        const e = catch_(() => revalidateCursor(payload, { ...ctx, activeSnapshotIdentity: 'other' }));
        expect(e).toBeInstanceOf(StaleCursorError);
        expect((e as StaleCursorError).httpStatus).toBe(409);
    });

    it('filter change -> FilterMismatchError (400)', () => {
        const e = catch_(() => revalidateCursor(payload, { ...ctx, activeFilterFingerprint: 'ff-zzz' }));
        expect(e).toBeInstanceOf(FilterMismatchError);
        expect((e as FilterMismatchError).httpStatus).toBe(400);
    });

    it('family mismatch -> InvalidCursorError (400)', () => {
        const e = catch_(() => revalidateCursor(payload, { ...ctx, family: 'nope' }));
        expect(e).toBeInstanceOf(InvalidCursorError);
        expect((e as InvalidCursorError).httpStatus).toBe(400);
    });

    it('page_ordinal out of range -> InvalidCursorError (400), NOT clamped', () => {
        const tampered = { ...payload, page_ordinal: 99 };
        const e = catch_(() => revalidateCursor(tampered, ctx));
        expect(e).toBeInstanceOf(InvalidCursorError);
        expect((e as InvalidCursorError).httpStatus).toBe(400);
    });

    it('in_page_offset out of range -> InvalidCursorError (400)', () => {
        const tampered = { ...payload, in_page_offset: 10 }; // recordCountForPage = 10 -> [0,10)
        expect(() => revalidateCursor(tampered, ctx)).toThrow(InvalidCursorError);
    });

    it('tampered-then-encoded cursor round-trips shape but is rejected on revalidate', () => {
        const tampered = decode(encode({ ...payload, page_ordinal: 999 }));
        expect(() => revalidateCursor(tampered, ctx)).toThrow(InvalidCursorError);
    });
});

function catch_(fn: () => unknown): unknown {
    try { fn(); } catch (e) { return e; }
    throw new Error('expected the function to throw');
}
