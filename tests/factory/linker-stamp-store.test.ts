// @ts-nocheck
/**
 * Tests for lib/linker-stamp-store.js (PR-B coverage-ceiling) -- the pure
 * parse/serialize halves of the R2-backed freshness state. R2 IO is not
 * exercised here (the daily F3 cron does end-to-end); the JSONL <-> Map
 * transforms are pinned: round-trip fidelity, deterministic byte order, and
 * malformed-line HALT-loud (no silent skip per [[cross_cycle_silent_data_loss]]).
 */

import { describe, it, expect } from 'vitest';
import { parseStamps, serializeStamps } from '../../scripts/factory/lib/linker-stamp-store.js';

describe('parseStamps', () => {
    it('parses {compound_id, queried_at} lines into a Map', () => {
        const text = [
            JSON.stringify({ compound_id: 'sciweon::compound::CID:2', queried_at: '2026-06-01T00:00:00Z' }),
            JSON.stringify({ compound_id: 'sciweon::compound::CID:1', queried_at: '2026-06-02T00:00:00Z' }),
        ].join('\n');
        const m = parseStamps(text);
        expect(m.size).toBe(2);
        expect(m.get('sciweon::compound::CID:1')).toBe('2026-06-02T00:00:00Z');
        expect(m.get('sciweon::compound::CID:2')).toBe('2026-06-01T00:00:00Z');
    });
    it('empty / blank input -> empty Map', () => {
        expect(parseStamps('').size).toBe(0);
        expect(parseStamps('\n\n').size).toBe(0);
        expect(parseStamps(undefined as unknown as string).size).toBe(0);
    });
    it('skips records missing required fields (defensive, but does NOT swallow JSON errors)', () => {
        const text = [
            JSON.stringify({ compound_id: 'x', queried_at: '2026-06-01T00:00:00Z' }),
            JSON.stringify({ compound_id: 'y' }), // no queried_at -> not added
        ].join('\n');
        const m = parseStamps(text);
        expect(m.size).toBe(1);
        expect(m.has('x')).toBe(true);
    });
    it('THROWS on a malformed JSON line (halt loud, never silent)', () => {
        const text = '{"compound_id":"x","queried_at":"2026-06-01T00:00:00Z"}\n{ this is not json';
        expect(() => parseStamps(text)).toThrow();
    });
});

describe('serializeStamps', () => {
    it('round-trips through parseStamps', () => {
        const m = new Map([
            ['sciweon::compound::CID:5', '2026-06-01T00:00:00Z'],
            ['sciweon::compound::CID:3', '2026-06-02T00:00:00Z'],
        ]);
        const reparsed = parseStamps(serializeStamps(m));
        expect(reparsed).toEqual(m);
    });
    it('is deterministic: sorted by compound_id regardless of insertion order', () => {
        const a = new Map([['c', '2026-01-01T00:00:00Z'], ['a', '2026-01-01T00:00:00Z'], ['b', '2026-01-01T00:00:00Z']]);
        const b = new Map([['b', '2026-01-01T00:00:00Z'], ['c', '2026-01-01T00:00:00Z'], ['a', '2026-01-01T00:00:00Z']]);
        expect(serializeStamps(a)).toBe(serializeStamps(b));
        // First record is the lex-min key.
        expect(serializeStamps(a).split('\n')[0]).toContain('"compound_id":"a"');
    });
    it('empty Map -> empty string (no trailing newline)', () => {
        expect(serializeStamps(new Map())).toBe('');
    });
    it('non-empty -> trailing newline', () => {
        expect(serializeStamps(new Map([['a', '2026-01-01T00:00:00Z']])).endsWith('\n')).toBe(true);
    });
});
