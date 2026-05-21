/**
 * Tests for pMap — bounded-concurrency parallel map.
 *
 * Anchors the C2-9 cross-source-linker parallelization: the linker swaps
 * its serial for-loop for `pMap(compounds, 4, fn)`, so pMap's correctness
 * properties (concurrency bound / completeness / error propagation) are
 * load-bearing for ChEMBL rate-limit safety + the no-silent-data-loss rule.
 */

import { describe, it, expect } from 'vitest';
import { pMap } from '../../scripts/factory/lib/p-map.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('pMap', () => {
    it('processes every item exactly once', async () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const seen = new Set<number>();
        await pMap(items, 3, async (x) => {
            seen.add(x);
            return x;
        });
        expect(seen.size).toBe(items.length);
        for (const x of items) expect(seen.has(x)).toBe(true);
    });

    it('never exceeds the concurrency bound', async () => {
        let inflight = 0;
        let peak = 0;
        const items = Array.from({ length: 20 }, (_, i) => i);
        await pMap(items, 4, async () => {
            inflight++;
            peak = Math.max(peak, inflight);
            await tick(5);
            inflight--;
        });
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBeGreaterThan(1); // sanity: actually went parallel
    });

    it('returns one result per input item', async () => {
        const items = [10, 20, 30, 40, 50];
        const results = await pMap(items, 2, async (x) => x * 2);
        expect(results).toHaveLength(items.length);
        // Completion order is non-deterministic; assert by set membership.
        expect(new Set(results)).toEqual(new Set([20, 40, 60, 80, 100]));
    });

    it('propagates the first rejection and halts further dispatch', async () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        let started = 0;
        await expect(
            pMap(items, 2, async (x) => {
                started++;
                if (x === 3) throw new Error('boom');
                await tick(10);
                return x;
            }),
        ).rejects.toThrow(/boom/);
        // After the error, no NEW items should be pulled; in-flight ones
        // finish. With concurrency 2, started should be well under 8.
        expect(started).toBeLessThan(items.length);
    });

    it('handles empty input', async () => {
        const results = await pMap([], 4, async (x) => x);
        expect(results).toEqual([]);
    });

    it('rejects invalid arguments', async () => {
        await expect(pMap([1, 2], 0, async () => 1)).rejects.toThrow(/concurrency/);
        await expect(pMap([1, 2], -1, async () => 1)).rejects.toThrow(/concurrency/);
        await expect(pMap([1, 2], 1.5, async () => 1)).rejects.toThrow(/concurrency/);
        // @ts-expect-error — runtime guard against non-array input
        await expect(pMap('nope', 1, async () => 1)).rejects.toThrow(/items must be an array/);
    });
});
