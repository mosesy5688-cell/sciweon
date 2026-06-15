/**
 * RK-16A1 — ref primitives: the four ref types are NOT interchangeable and a
 * posting list may never point at a canonical page.
 */
import { describe, it, expect } from 'vitest';
import {
    isRecordLocator, isCanonicalPageRef, isPostingPageRef, isPostingDirectoryRef,
    isPostingListEntry, assertPostingTargetsProjectionNotCanonical,
    PostingTargetContractError,
    type RecordLocator, type CanonicalPageRef, type PostingPageRef, type PostingDirectoryRef,
} from '../../../src/worker/lib/rk16/refs';

const recordLocator = {
    kind: 'record_locator', shard_key: 's/0', byte_offset: 0, byte_length: 10,
    canonical_id: 'C1', content_hash: 'h1',
} as unknown as RecordLocator;

const canonicalPage = {
    kind: 'canonical_page_ref', shard_key: 's/0', page_offset: 0, page_length: 100,
    record_count: 5, content_hash: 'h2',
} as unknown as CanonicalPageRef;

const postingPage = {
    kind: 'posting_page_ref', shard_key: 's/0', page_offset: 0, page_length: 100,
    record_count: 5, cursor_min: 'a', cursor_max: 'z', page_sha256: 'h3',
} as unknown as PostingPageRef;

const postingDir = {
    kind: 'posting_directory_ref', directory_shard_key: 'd/0', directory_offset: 0,
    directory_length: 50, page_ref_count: 3, directory_sha256: 'h4',
} as unknown as PostingDirectoryRef;

describe('RK-16A1 refs — the four ref types are NOT interchangeable', () => {
    it('each guard accepts only its own kind', () => {
        expect(isRecordLocator(recordLocator)).toBe(true);
        expect(isRecordLocator(canonicalPage)).toBe(false);
        expect(isRecordLocator(postingPage)).toBe(false);

        expect(isCanonicalPageRef(canonicalPage)).toBe(true);
        expect(isCanonicalPageRef(recordLocator)).toBe(false);
        expect(isCanonicalPageRef(postingPage)).toBe(false);

        expect(isPostingPageRef(postingPage)).toBe(true);
        expect(isPostingPageRef(canonicalPage)).toBe(false);
        expect(isPostingPageRef(postingDir)).toBe(false);

        expect(isPostingDirectoryRef(postingDir)).toBe(true);
        expect(isPostingDirectoryRef(postingPage)).toBe(false);
        expect(isPostingDirectoryRef(canonicalPage)).toBe(false);
    });

    it('guards reject malformed / wrong-typed fields', () => {
        expect(isRecordLocator({ kind: 'record_locator', shard_key: 's' })).toBe(false);
        expect(isPostingPageRef({ ...postingPage, page_offset: 'x' })).toBe(false);
    });
});

describe('RK-16A1 refs — a posting list may not point at a canonical page', () => {
    it('isPostingListEntry accepts only posting page/directory refs', () => {
        expect(isPostingListEntry(postingPage)).toBe(true);
        expect(isPostingListEntry(postingDir)).toBe(true);
        expect(isPostingListEntry(canonicalPage)).toBe(false);
        expect(isPostingListEntry(recordLocator)).toBe(false);
    });

    it('assertPostingTargetsProjectionNotCanonical passes for posting refs', () => {
        expect(() => assertPostingTargetsProjectionNotCanonical(postingPage)).not.toThrow();
        expect(() => assertPostingTargetsProjectionNotCanonical(postingDir)).not.toThrow();
    });

    it('THROWS for a canonical page ref (the encoded contract rule)', () => {
        expect(() => assertPostingTargetsProjectionNotCanonical(canonicalPage))
            .toThrow(PostingTargetContractError);
    });

    it('THROWS for a record locator', () => {
        let caught: unknown;
        try { assertPostingTargetsProjectionNotCanonical(recordLocator); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(PostingTargetContractError);
        expect((caught as PostingTargetContractError).observed_kind).toBe('record_locator');
    });

    it('THROWS for a non-ref value', () => {
        expect(() => assertPostingTargetsProjectionNotCanonical(null)).toThrow(PostingTargetContractError);
        expect(() => assertPostingTargetsProjectionNotCanonical({ kind: 'nope' })).toThrow(PostingTargetContractError);
    });
});
