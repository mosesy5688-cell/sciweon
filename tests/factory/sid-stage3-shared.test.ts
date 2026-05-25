// @ts-nocheck
// Phase 1.5 partitioned dispatcher API tests (defect-13 verification).
// Pure-function aspects only (R2 IO not exercised here; integration verified via live dispatch).
import { describe, it, expect } from 'vitest';
import { partitionAdditionsByShardPrefix } from '../../scripts/factory/lib/sid-stage3-shared.js';

function mkEntry(sidS, sidC = 'sc') {
    return {
        sid_s: sidS, sid_c: sidC,
        entity_class: 'bioactivity',
        canonicalization_version: 'bioactivity.chembl.v1.0',
        canonical_identity_payload: `chembl:${sidC}`,
        counter_value: 1, reservation_id: 'r', issuance_at: '2026-05-25T00:00:00Z',
    };
}

describe('partitionAdditionsByShardPrefix — defect-13 verification', () => {
    it('empty input -> empty partitions Map', () => {
        const p = partitionAdditionsByShardPrefix([]);
        expect(p.size).toBe(0);
    });

    it('single addition -> single shard with one entry', () => {
        const p = partitionAdditionsByShardPrefix([mkEntry('ab12cd34')]);
        expect(p.size).toBe(1);
        expect(p.get('ab')).toHaveLength(1);
    });

    it('★ defect-13 critical: all entries grouped under their sid_s[0..2] prefix correctly', () => {
        const entries = [
            mkEntry('ab01...'), mkEntry('ab99...'), mkEntry('cd11...'),
            mkEntry('ef88...'), mkEntry('ab44...'), mkEntry('00ff...'),
        ];
        const p = partitionAdditionsByShardPrefix(entries);
        expect(p.size).toBe(4); // 'ab', 'cd', 'ef', '00'
        expect(p.get('ab')).toHaveLength(3);
        expect(p.get('cd')).toHaveLength(1);
        expect(p.get('ef')).toHaveLength(1);
        expect(p.get('00')).toHaveLength(1);
    });

    it('★ defect-13 critical: each partition contains ONLY entries whose sid_s prefix matches the shard key', () => {
        const entries = [
            mkEntry('ab01'), mkEntry('ab02'), mkEntry('ab03'),
            mkEntry('cd01'), mkEntry('cd02'),
        ];
        const p = partitionAdditionsByShardPrefix(entries);
        for (const [prefix, slice] of p.entries()) {
            for (const entry of slice) {
                expect(entry.sid_s.substring(0, 2)).toBe(prefix);
            }
        }
    });

    it('routing invariant: sum of partition sizes equals input length', () => {
        const entries = [
            mkEntry('aa01'), mkEntry('bb02'), mkEntry('cc03'), mkEntry('dd04'),
            mkEntry('aa05'), mkEntry('ee06'),
        ];
        const p = partitionAdditionsByShardPrefix(entries);
        const sum = Array.from(p.values()).reduce((s, slice) => s + slice.length, 0);
        expect(sum).toBe(entries.length);
    });

    it('deterministic partitioning: same input -> same partitions', () => {
        const entries = [mkEntry('ab01'), mkEntry('cd02'), mkEntry('ab03')];
        const p1 = partitionAdditionsByShardPrefix(entries);
        const p2 = partitionAdditionsByShardPrefix(entries);
        expect(Array.from(p1.keys()).sort()).toEqual(Array.from(p2.keys()).sort());
        expect(p1.get('ab').length).toBe(p2.get('ab').length);
    });

    it('throws on non-array input', () => {
        expect(() => partitionAdditionsByShardPrefix(null)).toThrow(/array/);
        expect(() => partitionAdditionsByShardPrefix('str')).toThrow(/array/);
    });

    it('throws on entry missing sid_s', () => {
        expect(() => partitionAdditionsByShardPrefix([{ sid_c: 'xyz' }])).toThrow(/sid_s/);
    });

    it('throws on entry with short sid_s (<2 chars)', () => {
        expect(() => partitionAdditionsByShardPrefix([mkEntry('a')])).toThrow(/sid_s/);
    });

    it('handles realistic uniform-distribution sample (~16 different prefixes)', () => {
        const entries = [];
        for (let i = 0; i < 256; i++) {
            const hex = i.toString(16).padStart(2, '0');
            entries.push(mkEntry(`${hex}deadbeef0000000000000000000000`));
        }
        const p = partitionAdditionsByShardPrefix(entries);
        expect(p.size).toBe(256);
        for (let i = 0; i < 256; i++) {
            const hex = i.toString(16).padStart(2, '0');
            expect(p.get(hex)).toHaveLength(1);
        }
    });
});
