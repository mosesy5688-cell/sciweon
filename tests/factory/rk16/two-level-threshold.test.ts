// @ts-nocheck
/**
 * RK-16A2 — flat -> two-level threshold (count>64 OR inline>1MiB), depth==1,
 * FAIL-LOUD on a flat list over the cap.
 */
import { describe, it, expect } from 'vitest';
import {
    decide, PER_KEY_INLINE_PAGEREF_CAP, INLINE_MANIFEST_BYTES_CEILING, DIRECTORY_DEPTH,
} from '../../../scripts/factory/lib/rk16/posting-threshold.js';
import {
    writePostingList, emitFlatOrThrow,
} from '../../../scripts/factory/lib/rk16/posting-directory-writer.js';

function makePageRefs(n, pad = '') {
    const refs = [];
    for (let i = 0; i < n; i++) {
        refs.push({
            kind: 'posting_page_ref',
            shard_key: `proj/shard-000.bin${pad}`,
            page_offset: i * 100,
            page_length: 100,
            record_count: 5,
            cursor_min: `K${i}`,
            cursor_max: `K${i}`,
            page_sha256: 'f'.repeat(64),
        });
    }
    return refs;
}

describe('posting-threshold + directory-writer', () => {
    it('64 refs -> flat; 65 refs -> two-level', async () => {
        expect(decide(makePageRefs(64)).two_level).toBe(false);
        expect(decide(makePageRefs(65)).two_level).toBe(true);
        expect(PER_KEY_INLINE_PAGEREF_CAP).toBe(64);

        const flat = await writePostingList(makePageRefs(64));
        expect(flat.two_level).toBe(false);
        expect(Array.isArray(flat.posting_list)).toBe(true);

        const twoLevel = await writePostingList(makePageRefs(65), { directoryShardKey: 'dir/shard-000.bin' });
        expect(twoLevel.two_level).toBe(true);
        expect(twoLevel.posting_list.kind).toBe('posting_directory_ref');
        expect(twoLevel.posting_list.page_ref_count).toBe(65);
        expect(twoLevel.posting_list.directory_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('oversized inline (> 1 MiB) with <= 64 refs still goes two-level', async () => {
        // 10 refs, but each padded so JSON serialization exceeds 1 MiB.
        const bigPad = 'x'.repeat(Math.ceil(INLINE_MANIFEST_BYTES_CEILING / 8));
        const refs = makePageRefs(8, bigPad);
        const d = decide(refs);
        expect(d.page_ref_count).toBeLessThanOrEqual(PER_KEY_INLINE_PAGEREF_CAP);
        expect(d.inline_bytes).toBeGreaterThan(INLINE_MANIFEST_BYTES_CEILING);
        expect(d.two_level).toBe(true);
        expect(d.reason).toBe('bytes');
        const res = await writePostingList(refs);
        expect(res.posting_list.kind).toBe('posting_directory_ref');
    });

    it('directory_depth stays exactly 1', () => {
        expect(DIRECTORY_DEPTH).toBe(1);
        expect(decide(makePageRefs(65)).directory_depth).toBe(1);
        expect(decide(makePageRefs(10)).directory_depth).toBe(0);
    });

    it('emitting a flat list over the cap FAILS LOUD', () => {
        expect(() => emitFlatOrThrow(makePageRefs(64))).not.toThrow();
        expect(() => emitFlatOrThrow(makePageRefs(65))).toThrow(/two-level/i);
    });
});
