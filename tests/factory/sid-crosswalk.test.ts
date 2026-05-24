// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    crosswalkKey,
    parseCrosswalkLine,
    parseCrosswalkJsonl,
    validateCrosswalkEntry,
    buildCrosswalkIndex,
    lookupBySidS,
    lookupBySidC,
    serializeEntries,
    mergeEntries,
    CROSSWALK_PREFIX,
} from '../../scripts/factory/lib/sid-crosswalk.js';

const ASPIRIN_ENTRY = {
    sid_s: 'c1fe6bb77cec6b1e3ecd0061a5dc749e',
    sid_c: '9549658c8384b75a751de9d7eaa28d4d',
    entity_class: 'small_molecule',
    canonicalization_version: 'compound.inchikey.v1.0',
    canonical_identity_payload: 'inchikey:BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
    counter_value: 1,
    reservation_id: 'rid-aspirin',
    issuance_at: '2026-05-24T12:00:00Z',
};

const CAFFEINE_ENTRY = {
    sid_s: 'aaaa1111aaaa1111aaaa1111aaaa1111',
    sid_c: 'bbbb2222bbbb2222bbbb2222bbbb2222',
    entity_class: 'small_molecule',
    canonicalization_version: 'compound.inchikey.v1.0',
    canonical_identity_payload: 'inchikey:RYYVLZVUVIJVGH-UHFFFAOYSA-N',
    counter_value: 2,
    reservation_id: 'rid-caffeine',
    issuance_at: '2026-05-24T12:01:00Z',
};

describe('CROSSWALK_PREFIX constant', () => {
    it('locked to canonical R2 prefix per V1.0 §35', () => {
        expect(CROSSWALK_PREFIX).toBe('state/sid-crosswalk/');
    });
});

describe('crosswalkKey', () => {
    it('formats entity_class into CROSSWALK_PREFIX path', () => {
        expect(crosswalkKey('small_molecule')).toBe('state/sid-crosswalk/small_molecule.jsonl.zst');
    });
    it('handles different entity classes', () => {
        expect(crosswalkKey('trial')).toBe('state/sid-crosswalk/trial.jsonl.zst');
        expect(crosswalkKey('paper')).toBe('state/sid-crosswalk/paper.jsonl.zst');
    });
    it('throws on missing entity_class', () => {
        expect(() => crosswalkKey('')).toThrow(/entityClass/);
        expect(() => crosswalkKey(null)).toThrow(/entityClass/);
    });
});

describe('validateCrosswalkEntry', () => {
    it('accepts valid entry', () => {
        expect(validateCrosswalkEntry(ASPIRIN_ENTRY)).toBe(true);
    });
    it('throws on missing sid_s', () => {
        expect(() => validateCrosswalkEntry({ ...ASPIRIN_ENTRY, sid_s: '' })).toThrow(/sid_s/);
    });
    it('throws on missing sid_c', () => {
        expect(() => validateCrosswalkEntry({ ...ASPIRIN_ENTRY, sid_c: '' })).toThrow(/sid_c/);
    });
    it('throws on missing entity_class', () => {
        expect(() => validateCrosswalkEntry({ ...ASPIRIN_ENTRY, entity_class: '' })).toThrow(/entity_class/);
    });
    it('throws on missing canonicalization_version', () => {
        expect(() => validateCrosswalkEntry({ ...ASPIRIN_ENTRY, canonicalization_version: '' })).toThrow(/canonicalization_version/);
    });
    it('throws on counter_value=0 (1-indexed per §40)', () => {
        expect(() => validateCrosswalkEntry({ ...ASPIRIN_ENTRY, counter_value: 0 })).toThrow(/counter_value/);
    });
    it('throws on non-integer counter_value', () => {
        expect(() => validateCrosswalkEntry({ ...ASPIRIN_ENTRY, counter_value: 1.5 })).toThrow(/counter_value/);
    });
    it('throws on null entry', () => {
        expect(() => validateCrosswalkEntry(null)).toThrow(/entry/);
    });
});

describe('parseCrosswalkLine (append-only resilience per V1.0 §22)', () => {
    it('valid JSON line -> entry', () => {
        const line = JSON.stringify(ASPIRIN_ENTRY);
        expect(parseCrosswalkLine(line)).toEqual(ASPIRIN_ENTRY);
    });
    it('empty line -> null (skip, no throw)', () => {
        expect(parseCrosswalkLine('')).toBeNull();
        expect(parseCrosswalkLine('   ')).toBeNull();
    });
    it('malformed JSON -> null (skip, no throw — append-only file may have partial writes)', () => {
        expect(parseCrosswalkLine('{not valid json')).toBeNull();
        expect(parseCrosswalkLine('{}{')).toBeNull();
    });
    it('JSON literal non-object -> null', () => {
        expect(parseCrosswalkLine('null')).toBeNull();
        expect(parseCrosswalkLine('42')).toBeNull();
    });
    it('non-string input -> null', () => {
        expect(parseCrosswalkLine(null)).toBeNull();
        expect(parseCrosswalkLine(undefined)).toBeNull();
    });
});

describe('parseCrosswalkJsonl', () => {
    it('parses multi-line JSONL', () => {
        const text = JSON.stringify(ASPIRIN_ENTRY) + '\n' + JSON.stringify(CAFFEINE_ENTRY) + '\n';
        const entries = parseCrosswalkJsonl(text);
        expect(entries).toHaveLength(2);
        expect(entries[0].sid_s).toBe(ASPIRIN_ENTRY.sid_s);
        expect(entries[1].sid_s).toBe(CAFFEINE_ENTRY.sid_s);
    });
    it('skips empty lines and malformed lines without throwing', () => {
        const text = JSON.stringify(ASPIRIN_ENTRY) + '\n\n{not valid\n' + JSON.stringify(CAFFEINE_ENTRY) + '\n';
        const entries = parseCrosswalkJsonl(text);
        expect(entries).toHaveLength(2);
    });
    it('empty/null returns empty array', () => {
        expect(parseCrosswalkJsonl('')).toEqual([]);
        expect(parseCrosswalkJsonl(null)).toEqual([]);
    });
});

describe('buildCrosswalkIndex', () => {
    it('empty array -> empty maps', () => {
        const { bySidS, bySidC } = buildCrosswalkIndex([]);
        expect(bySidS.size).toBe(0);
        expect(bySidC.size).toBe(0);
    });
    it('1:1 case populates both maps', () => {
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY]);
        expect(idx.bySidS.get(ASPIRIN_ENTRY.sid_s)).toEqual([ASPIRIN_ENTRY]);
        expect(idx.bySidC.get(ASPIRIN_ENTRY.sid_c)).toEqual(ASPIRIN_ENTRY);
    });
    it('1:N split case per V1.0 §35: bySidS holds array of multiple entries with same sid_s', () => {
        const split1 = { ...ASPIRIN_ENTRY, sid_c: 'cccc3333cccc3333cccc3333cccc3333', counter_value: 3, reservation_id: 'rid-split-1' };
        const split2 = { ...ASPIRIN_ENTRY, sid_c: 'dddd4444dddd4444dddd4444dddd4444', counter_value: 4, reservation_id: 'rid-split-2' };
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY, split1, split2]);
        const arr = idx.bySidS.get(ASPIRIN_ENTRY.sid_s);
        expect(arr).toHaveLength(3);
        expect(arr.map(e => e.sid_c)).toEqual([ASPIRIN_ENTRY.sid_c, split1.sid_c, split2.sid_c]);
        expect(idx.bySidC.size).toBe(3);
    });
    it('skips entries with missing sid_s or sid_c', () => {
        const bad = { ...ASPIRIN_ENTRY, sid_s: '' };
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY, bad]);
        expect(idx.bySidS.size).toBe(1);
    });
    it('throws on non-array input', () => {
        expect(() => buildCrosswalkIndex(null)).toThrow(/array/);
    });
});

describe('lookupBySidS', () => {
    it('1:1 match returns single-entry array', () => {
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY]);
        expect(lookupBySidS(idx, ASPIRIN_ENTRY.sid_s)).toEqual([ASPIRIN_ENTRY]);
    });
    it('1:N match returns multi-entry array', () => {
        const split = { ...ASPIRIN_ENTRY, sid_c: 'cccc', counter_value: 5 };
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY, split]);
        expect(lookupBySidS(idx, ASPIRIN_ENTRY.sid_s)).toHaveLength(2);
    });
    it('missing sid_s returns empty array', () => {
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY]);
        expect(lookupBySidS(idx, 'nonexistent')).toEqual([]);
    });
    it('handles null index or sid_s gracefully', () => {
        expect(lookupBySidS(null, 'x')).toEqual([]);
        expect(lookupBySidS({ bySidS: new Map() }, '')).toEqual([]);
    });
});

describe('lookupBySidC', () => {
    it('match returns entry', () => {
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY]);
        expect(lookupBySidC(idx, ASPIRIN_ENTRY.sid_c)).toEqual(ASPIRIN_ENTRY);
    });
    it('missing sid_c returns null', () => {
        const idx = buildCrosswalkIndex([ASPIRIN_ENTRY]);
        expect(lookupBySidC(idx, 'nonexistent')).toBeNull();
    });
    it('handles null index or sid_c gracefully', () => {
        expect(lookupBySidC(null, 'x')).toBeNull();
        expect(lookupBySidC({ bySidC: new Map() }, '')).toBeNull();
    });
});

describe('serializeEntries', () => {
    it('round-trips via parseCrosswalkJsonl', () => {
        const text = serializeEntries([ASPIRIN_ENTRY, CAFFEINE_ENTRY]);
        const parsed = parseCrosswalkJsonl(text);
        expect(parsed).toEqual([ASPIRIN_ENTRY, CAFFEINE_ENTRY]);
    });
    it('empty array -> empty string', () => {
        expect(serializeEntries([])).toBe('');
    });
    it('terminates with newline', () => {
        const text = serializeEntries([ASPIRIN_ENTRY]);
        expect(text.endsWith('\n')).toBe(true);
    });
    it('throws on non-array', () => {
        expect(() => serializeEntries(null)).toThrow(/array/);
    });
});

describe('mergeEntries (append-only semantics per V1.0 §22)', () => {
    it('concatenates additions onto existing', () => {
        const merged = mergeEntries([ASPIRIN_ENTRY], [CAFFEINE_ENTRY]);
        expect(merged).toEqual([ASPIRIN_ENTRY, CAFFEINE_ENTRY]);
    });
    it('empty additions preserves existing', () => {
        const merged = mergeEntries([ASPIRIN_ENTRY], []);
        expect(merged).toEqual([ASPIRIN_ENTRY]);
    });
    it('empty existing returns additions', () => {
        const merged = mergeEntries([], [ASPIRIN_ENTRY]);
        expect(merged).toEqual([ASPIRIN_ENTRY]);
    });
    it('throws on non-array existing', () => {
        expect(() => mergeEntries(null, [])).toThrow(/existing/);
    });
    it('throws on non-array additions', () => {
        expect(() => mergeEntries([], null)).toThrow(/additions/);
    });
});
