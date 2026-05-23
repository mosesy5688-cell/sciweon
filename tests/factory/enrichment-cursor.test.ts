/**
 * Tests for lib/enrichment-cursor.js - cycle 22 PR-CORE-2 substrate.
 * R2 IO not exercised here (workflow does end-to-end). Pure-function
 * chunk iterator semantics are pinned: lex-sort determinism, cursor
 * advance, tail wrap, chunk_size override.
 */

import { describe, it, expect } from 'vitest';
import { chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE } from '../../scripts/factory/lib/enrichment-cursor.js';

function mkRec(id: string) { return { id }; }

describe('chunkIterator', () => {
    it('first call (cursor=null) starts from lex-min id', () => {
        const recs = [mkRec('c'), mkRec('a'), mkRec('b')];
        const r = chunkIterator(recs, null, 2);
        expect(r.slice.map(x => x.id)).toEqual(['a', 'b']);
        expect(r.nextCursorId).toBe('b');
        expect(r.wrapped).toBe(false);
        expect(r.totalEligible).toBe(3);
    });

    it('advances past previous cursor_id', () => {
        const recs = ['a', 'b', 'c', 'd', 'e'].map(mkRec);
        const r = chunkIterator(recs, { cursor_id: 'b' }, 2);
        expect(r.slice.map(x => x.id)).toEqual(['c', 'd']);
        expect(r.nextCursorId).toBe('d');
        expect(r.wrapped).toBe(false);
    });

    it('wraps to start when remaining tail < chunkSize', () => {
        const recs = ['a', 'b', 'c', 'd', 'e'].map(mkRec);
        // cursor at 'd' -> tail is ['e'] (1) + head ['a','b'] (2) = 3 records to fill chunk=3
        const r = chunkIterator(recs, { cursor_id: 'd' }, 3);
        expect(r.slice.map(x => x.id)).toEqual(['e', 'a', 'b']);
        expect(r.nextCursorId).toBe('b');
        expect(r.wrapped).toBe(true);
    });

    it('cursor at end of list wraps fully', () => {
        const recs = ['a', 'b', 'c'].map(mkRec);
        const r = chunkIterator(recs, { cursor_id: 'c' }, 2);
        expect(r.slice.map(x => x.id)).toEqual(['a', 'b']);
        expect(r.nextCursorId).toBe('b');
        expect(r.wrapped).toBe(true);
    });

    it('cursor pointing at since-deleted id resumes at next existing', () => {
        const recs = ['a', 'c', 'e'].map(mkRec);
        // cursor_id='b' no longer exists; should resume at 'c'
        const r = chunkIterator(recs, { cursor_id: 'b' }, 2);
        expect(r.slice.map(x => x.id)).toEqual(['c', 'e']);
    });

    it('chunkSize larger than corpus returns entire corpus + wraps', () => {
        const recs = ['a', 'b', 'c'].map(mkRec);
        const r = chunkIterator(recs, null, 10);
        expect(r.slice.length).toBe(3);
        expect(r.wrapped).toBe(true);
    });

    it('empty records yields empty slice (no crash)', () => {
        const r = chunkIterator([], null, 5);
        expect(r.slice).toEqual([]);
        expect(r.nextCursorId).toBe(null);
        expect(r.wrapped).toBe(true);
    });

    it('default chunk size constant matches plan D4 (5000)', () => {
        expect(DEFAULT_CHUNK_SIZE).toBe(5000);
    });

    it('throws on non-array input', () => {
        expect(() => chunkIterator(null as unknown as never, null)).toThrow();
        expect(() => chunkIterator({} as unknown as never, null)).toThrow();
    });

    it('throws on non-positive chunkSize', () => {
        expect(() => chunkIterator([], null, 0)).toThrow();
        expect(() => chunkIterator([], null, -1)).toThrow();
    });

    it('lex order is deterministic regardless of input order', () => {
        const a = [mkRec('z'), mkRec('a'), mkRec('m')];
        const b = [mkRec('m'), mkRec('z'), mkRec('a')];
        const ra = chunkIterator(a, null, 3);
        const rb = chunkIterator(b, null, 3);
        expect(ra.slice.map(x => x.id)).toEqual(rb.slice.map(x => x.id));
    });
});

describe('buildNextCursor', () => {
    it('increments cycles_completed when wrapped', () => {
        const next = buildNextCursor({
            source: 'rxnorm',
            prev: { source: 'rxnorm', cursor_id: 'x', cycles_completed: 2 } as never,
            chunkResult: { slice: [], nextCursorId: 'y', wrapped: true, totalEligible: 100 },
            processedCount: 5000,
            totalEligible: 100,
        });
        expect(next.cycles_completed).toBe(3);
        expect(next.cursor_id).toBe('y');
        expect(next.source).toBe('rxnorm');
        expect(next.processed_in_run).toBe(5000);
        expect(next.total_eligible_at_last_run).toBe(100);
        expect(typeof next.last_run).toBe('string');
    });

    it('does not increment cycles_completed when not wrapped', () => {
        const next = buildNextCursor({
            source: 'rxnorm',
            prev: { source: 'rxnorm', cursor_id: 'x', cycles_completed: 2 } as never,
            chunkResult: { slice: [], nextCursorId: 'y', wrapped: false, totalEligible: 100 },
            processedCount: 5000,
            totalEligible: 100,
        });
        expect(next.cycles_completed).toBe(2);
    });

    it('uses default chunk_size when prev is null', () => {
        const next = buildNextCursor({
            source: 'unichem',
            prev: null,
            chunkResult: { slice: [], nextCursorId: 'a', wrapped: false, totalEligible: 10 },
            processedCount: 5000,
            totalEligible: 10,
        });
        expect(next.chunk_size).toBe(DEFAULT_CHUNK_SIZE);
        expect(next.cycles_completed).toBe(0);
    });

    it('preserves prev.chunk_size override', () => {
        const next = buildNextCursor({
            source: 'pubchem_bioassay',
            prev: { source: 'pubchem_bioassay', cursor_id: null, chunk_size: 20000 } as never,
            chunkResult: { slice: [], nextCursorId: 'a', wrapped: false, totalEligible: 10 },
            processedCount: 20000,
            totalEligible: 10,
        });
        expect(next.chunk_size).toBe(20000);
    });

    it('PR-CORE-3b: explicit chunkSize param overrides default + prev (persistence bug fix)', () => {
        // Caller with a non-default fallback (e.g. aggregated-backfill-enrich
        // uses 2000) must persist its effective value, not the global default.
        const next = buildNextCursor({
            source: 'rxnorm',
            prev: null,  // first cycle, no prev cursor
            chunkResult: { slice: [], nextCursorId: 'a', wrapped: false, totalEligible: 10 },
            processedCount: 2000,
            totalEligible: 10,
            chunkSize: 2000,
        });
        expect(next.chunk_size).toBe(2000);
    });

    it('PR-CORE-3b: explicit chunkSize wins over prev.chunk_size when both present', () => {
        const next = buildNextCursor({
            source: 'rxnorm',
            prev: { source: 'rxnorm', cursor_id: 'x', chunk_size: 5000 } as never,
            chunkResult: { slice: [], nextCursorId: 'y', wrapped: false, totalEligible: 100 },
            processedCount: 2000,
            totalEligible: 100,
            chunkSize: 2000,
        });
        expect(next.chunk_size).toBe(2000);
    });
});
