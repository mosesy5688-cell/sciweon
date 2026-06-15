// @ts-nocheck
/**
 * RK-16A2 — generic PartitionedSublist: arbitrary name -> sublist, NO hardcoded
 * partition names anywhere in the substrate.
 */
import { describe, it, expect } from 'vitest';
import { buildPartitionedSublist } from '../../../scripts/factory/lib/rk16/partitioned-sublist.js';
import fs from 'fs';

const flatList = [{ kind: 'posting_page_ref', shard_key: 's', page_offset: 0, page_length: 1, record_count: 1, cursor_min: 'a', cursor_max: 'a', page_sha256: 'f'.repeat(64) }];
const dirRef = { kind: 'posting_directory_ref', directory_shard_key: 's', directory_offset: 0, directory_length: 1, page_ref_count: 99, directory_sha256: 'e'.repeat(64) };

describe('partitioned-sublist', () => {
    it('maps arbitrary partition names to flat lists OR directory refs', () => {
        const ps = buildPartitionedSublist([
            { partition_name: 'arbitrary_one', posting_list: flatList },
            { partition_name: 'zeta_two', posting_list: dirRef },
        ]);
        expect(ps.partition_names).toEqual(['arbitrary_one', 'zeta_two']); // sorted, no semantics
        expect(ps.get('arbitrary_one')).toBe(flatList);
        expect(ps.get('zeta_two')).toBe(dirRef);
        expect(ps.get('missing')).toBeUndefined();
    });

    it('rejects empty / duplicate names', () => {
        expect(() => buildPartitionedSublist([{ partition_name: '', posting_list: flatList }])).toThrow();
        expect(() => buildPartitionedSublist([
            { partition_name: 'dup', posting_list: flatList },
            { partition_name: 'dup', posting_list: dirRef },
        ])).toThrow(/duplicate/i);
    });

    it('the substrate source hardcodes NO business partition names', () => {
        const src = fs.readFileSync(
            new URL('../../../scripts/factory/lib/rk16/partitioned-sublist.js', import.meta.url),
            'utf-8',
        );
        for (const banned of ['is_active', 'activity_type', 'CHEMBL', 'verdict']) {
            expect(src.includes(`'${banned}'`)).toBe(false);
            expect(src.includes(`"${banned}"`)).toBe(false);
        }
    });
});
