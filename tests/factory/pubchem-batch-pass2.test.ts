// @ts-nocheck
/**
 * PR-2 F1-harvest batch migration -- runBatchPass2 + no-loss integration (part 2).
 *
 * The getCompoundsBatch primitive is locked in pubchem-batch-harvest.test.ts
 * (split per the Art 5.1 250-line cap). This file drives the harvester batch
 * Pass-2 (runBatchPass2 + assertNoLoss, network-free via the deps seam) and
 * proves the zero-data-loss guarantee at the harvester layer:
 *   2. DEAD-CID A (Pass-2): an omitted CID is attempted, fetched, bucketed in
 *      noPropertyRecord.
 *   4. POISON-CID bisect (1 bad in 100): exactly 1 -> noPropertyRecord, 99 kept,
 *      ZERO in failedFetches.
 *   5. NO-LOSS INVARIANT: mixed live/dead/poison/macromolecule/missing-InChIKey
 *      -> attempted == valid + excluded + noRecord + failed; assertNoLoss does
 *      not throw; AND it throws LOUD on a corrupted tally.
 *   6. REQUEST-COUNT: 250 CIDs -> 3 property + 3 synonym requests; a 1-poison
 *      chunk -> bounded bisect overhead.
 *   7. TRANSIENT-5xx: a chunk exhausts on 503 -> getCompoundsBatch throws ->
 *      runBatchPass2 requeues all N -> failedFetches; none in noPropertyRecord;
 *      does NOT bisect. A network error behaves the same.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { setMode, MODE_REJECT } from '../../scripts/factory/lib/validation-gate.js';
import { getCompoundsBatch } from '../../scripts/factory/lib/pubchem-batch.js';
import { makeState, runBatchPass2, assertNoLoss } from '../../scripts/factory/lib/harvester-pass2.js';
import { rawFor, makeDeps } from './helpers/pubchem-batch-fixtures.js';

beforeAll(() => setMode(MODE_REJECT));

const NO_SLEEP = { chunkSize: 100, sleepFn: async () => {} };
// getBatch wired to a props fn (+ optional vi.fn wrap for call-count spies).
const batchFrom = (propsFn, wrap?) => (cs: number[]) =>
    getCompoundsBatch(cs, makeDeps(propsFn, undefined, wrap ?? (f => f)));

// ── 2. DEAD-CID A at Pass-2 ───────────────────────────────────────────────
describe('2. DEAD-CID A (Pass-2) — omitted CID -> attempted + fetched + noPropertyRecord', () => {
    it('the omitted CID is counted attempted, fetched, and bucketed (not silently dropped)', async () => {
        const state = makeState();
        const getBatch = batchFrom((cs: number[]) => cs.filter(c => c !== 11).map(c => rawFor(c)));
        await runBatchPass2(state, 10, 3, { getBatch, ...NO_SLEEP });
        expect(state.attempted).toBe(3);
        expect(state.fetched).toBe(3);
        expect(state.valid).toBe(2);
        expect(state.noPropertyRecord).toEqual([11]);
        expect(state.failedFetches).toHaveLength(0);
        assertNoLoss(state);
    });
});

// ── 4. POISON-CID bisect (1 bad in 100) ───────────────────────────────────
describe('4. POISON-CID bisect — 1 bad in 100: exactly 1 noRecord, 99 kept, ZERO failedFetches', () => {
    it('99 good preserved, the poison CID -> noPropertyRecord, none requeued', async () => {
        const poison = 1057;
        const state = makeState();
        const getBatch = batchFrom((cs: number[]) => {
            if (cs.includes(poison)) throw new Error(`HTTP 400: https://pubchem/post?cid=${cs.length}`);
            return cs.map(c => rawFor(c));
        });
        await runBatchPass2(state, 1000, 100, { getBatch, ...NO_SLEEP });
        expect(state.attempted).toBe(100);
        expect(state.valid).toBe(99);
        expect(state.noPropertyRecord).toEqual([poison]);
        expect(state.failedFetches).toHaveLength(0); // a 4xx never requeues
        assertNoLoss(state);
    });
});

// ── 5. NO-LOSS INVARIANT (mixed fixture) ──────────────────────────────────
describe('5. NO-LOSS INVARIANT — mixed live/dead/poison/macromolecule/missing-InChIKey', () => {
    it('attempted == valid + excluded + noRecord + failed; assertNoLoss does not throw', async () => {
        // CIDs 30..39: 30,31 live; 32 omitted (dead-A); 33 poison-400 (->bisect 4xx);
        // 34 macromolecule (MW 18657 -> scope excluded); 35 missing-InChIKey
        // (normalize->null -> noRecord); 36..39 live.
        const macro = (c: number) => rawFor(c, { MolecularWeight: '18657', MolecularFormula: 'C800H1200N200O250' });
        const noKey = (c: number) => { const r = rawFor(c); delete r.InChIKey; return r; };
        const state = makeState();
        const getBatch = batchFrom((cs: number[]) => {
            if (cs.includes(33)) throw new Error('HTTP 400: poison'); // bisects to single 33 -> 4xx
            return cs.filter(c => c !== 32).map(c =>
                c === 34 ? macro(c) : c === 35 ? noKey(c) : rawFor(c));
        });
        await runBatchPass2(state, 30, 10, { getBatch, ...NO_SLEEP });

        expect(state.attempted).toBe(10);
        expect(state.valid).toBe(6);                          // 30,31,36,37,38,39
        expect(state.excludedOutOfScope).toHaveLength(1);     // 34 macromolecule
        expect(state.excludedOutOfScope[0].reason).toBe('macromolecule_out_of_scope');
        expect(state.noPropertyRecord.sort((a, b) => a - b)).toEqual([32, 33, 35]);
        expect(state.failedFetches).toHaveLength(0);
        expect(() => assertNoLoss(state)).not.toThrow();
        expect(state.attempted).toBe(
            state.valid + state.excludedOutOfScope.length + state.noPropertyRecord.length + state.failedFetches.length);
    });

    it('assertNoLoss THROWS LOUD on a deliberately-corrupted tally (proves it is a real guard)', () => {
        const state = makeState();
        state.attempted = 5; state.valid = 2; // 3 unaccounted -> must throw
        expect(() => assertNoLoss(state)).toThrow(/NO-LOSS INVARIANT VIOLATED/);
    });
});

// ── 6. REQUEST-COUNT ──────────────────────────────────────────────────────
describe('6. REQUEST-COUNT — 1 prop + 1 syn per chunk; poison adds bounded bisect overhead', () => {
    it('250 CIDs happy -> 3 property + 3 synonym requests', async () => {
        const props = vi.fn(async (cs: number[]) => cs.map(c => rawFor(c)));
        const syns = vi.fn(async (cs: number[]) => new Map(cs.map(c => [String(c), []])));
        const d = { batchFetchProperties: props, batchFetchSynonyms: syns, normalize: makeDeps(() => []).normalize };
        const state = makeState();
        const getBatch = (cs: number[]) => getCompoundsBatch(cs, d);
        await runBatchPass2(state, 1, 250, { getBatch, ...NO_SLEEP });
        expect(state.attempted).toBe(250);
        expect(state.valid).toBe(250);
        expect(props).toHaveBeenCalledTimes(3); // ceil(250/100)
        expect(syns).toHaveBeenCalledTimes(3);
    });

    it('a 1-poison chunk adds only bounded bisect overhead (<= 1 + 2*ceil(log2(100)))', async () => {
        const poison = 57;
        const props = vi.fn(async (cs: number[]) => {
            if (cs.includes(poison)) throw new Error('HTTP 400: poison');
            return cs.map(c => rawFor(c));
        });
        const d = { batchFetchProperties: props, batchFetchSynonyms: async () => new Map(), normalize: makeDeps(() => []).normalize };
        const state = makeState();
        const getBatch = (cs: number[]) => getCompoundsBatch(cs, d);
        await runBatchPass2(state, 1, 100, { getBatch, ...NO_SLEEP });
        expect(state.valid).toBe(99);
        expect(state.noPropertyRecord).toEqual([poison]);
        const propCalls = props.mock.calls.length;
        expect(propCalls).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(100)));
        expect(propCalls).toBeGreaterThan(1); // proof it bisected
    });
});

// ── 7. TRANSIENT-5xx requeue (no bisect) ──────────────────────────────────
describe('7. TRANSIENT-5xx — chunk exhausts on 503 -> throws -> all N requeue (no bisect)', () => {
    it('all N -> failedFetches, none in noPropertyRecord, attempted counts all N, does NOT bisect', async () => {
        const cids = [70, 71, 72, 73];
        // A 5xx exhaustion message carries `(attempt N/M)` -> NOT a clean 4xx.
        const props = vi.fn(() => { throw new Error('HTTP 503: https://pubchem/post (attempt 3/3)'); });
        const state = makeState();
        const getBatch = (cs: number[]) => getCompoundsBatch(cs, makeDeps(props));
        await runBatchPass2(state, 70, 4, { getBatch, ...NO_SLEEP });
        expect(state.attempted).toBe(4);
        expect(state.fetched).toBe(0);
        expect(state.failedFetches.map(f => f.cid).sort((a, b) => a - b)).toEqual(cids);
        expect(state.noPropertyRecord).toHaveLength(0);
        expect(props).toHaveBeenCalledTimes(1); // did NOT bisect
        assertNoLoss(state); // 0 + 0 + 0 + 4 == 4 attempted
    });

    it('a network error (non-HTTP message) also re-throws (requeue), never bisects', async () => {
        const props = vi.fn(() => { throw new Error('fetch failed'); });
        const state = makeState();
        const getBatch = (cs: number[]) => getCompoundsBatch(cs, makeDeps(props));
        await runBatchPass2(state, 80, 4, { getBatch, ...NO_SLEEP });
        expect(state.failedFetches).toHaveLength(4);
        expect(props).toHaveBeenCalledTimes(1);
    });
});
