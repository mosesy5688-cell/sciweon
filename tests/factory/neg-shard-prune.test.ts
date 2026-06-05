// @ts-nocheck
/**
 * neg-shard-prune retention: decidePruneTargets must KEEP the pointer date +
 * the last keepN snapshots' shards, and NEVER propose pruning the date the
 * live pointer references. (Whole-files are never under the shard prefix, so
 * the IO wrapper can only touch bucket-* keys — asserted in the module.)
 */

import { describe, it, expect } from 'vitest';
import { decidePruneTargets } from '../../scripts/factory/lib/neg-shard-prune.js';

describe('decidePruneTargets — retention policy', () => {
    it('keeps pointer date + last keepN, prunes older', () => {
        const dates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
        const { prune, keep } = decidePruneTargets(dates, '2026-06-05', 2);
        // keep = pointer (06-05) + last 2 (06-04, 06-05)
        expect(keep).toEqual(['2026-06-04', '2026-06-05']);
        expect(prune).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    });

    it('NEVER prunes the pointer date even if it is old', () => {
        const dates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'];
        // pointer is an OLDER date than the most recent shards
        const { prune, keep } = decidePruneTargets(dates, '2026-06-01', 2);
        expect(prune).not.toContain('2026-06-01');
        expect(keep).toContain('2026-06-01');
        // still keeps the last 2
        expect(keep).toContain('2026-06-03');
        expect(keep).toContain('2026-06-04');
    });

    it('keepN larger than available -> prunes nothing', () => {
        const dates = ['2026-06-01', '2026-06-02'];
        const { prune } = decidePruneTargets(dates, '2026-06-02', 5);
        expect(prune).toEqual([]);
    });

    it('keepN=1 keeps only pointer + most recent', () => {
        const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];
        const { prune, keep } = decidePruneTargets(dates, '2026-06-03', 1);
        expect(keep).toEqual(['2026-06-03']);
        expect(prune).toEqual(['2026-06-01', '2026-06-02']);
    });

    it('dedupes + sorts unsorted input', () => {
        const dates = ['2026-06-03', '2026-06-01', '2026-06-03', '2026-06-02'];
        const { prune, keep } = decidePruneTargets(dates, '2026-06-03', 2);
        expect(keep).toEqual(['2026-06-02', '2026-06-03']);
        expect(prune).toEqual(['2026-06-01']);
    });

    it('handles missing pointerDate (keeps last keepN only)', () => {
        const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];
        const { prune, keep } = decidePruneTargets(dates, null, 2);
        expect(keep).toEqual(['2026-06-02', '2026-06-03']);
        expect(prune).toEqual(['2026-06-01']);
    });
});
