// @ts-nocheck
/**
 * Integration-shape test for the PR-B coverage cursor at the LINKER layer
 * (no network / no R2): proves the exact pipeline the trial/paper linkers run --
 *   applyStampsToCompounds (R2 stamp Map -> compound.linkage)
 *   -> isEligibleForQuery (skip-if-fresh denominator)
 *   -> chunkIterator (cursored slice)
 * advances across successive runs through ALL compounds and SKIPS fresh ones.
 * This is the load-bearing proof that the O(50) ceiling (B2) is gone: every
 * compound is reached over time, and re-querying is gated by the freshness
 * window -- a cadence mechanism, never a cap (no Top-N / volume cut).
 */

import { describe, it, expect } from 'vitest';
import { applyStampsToCompounds } from '../../scripts/factory/lib/linker-coverage-runner.js';
import { chunkIterator, buildNextCursor } from '../../scripts/factory/lib/enrichment-cursor.js';
import { TRIALS_STAMP_FIELD, isEligibleForQuery } from '../../scripts/factory/lib/linker-coverage.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-05T00:00:00.000Z');

function corpus(n: number) {
    // Stable ids so lex order is deterministic (CID:0001..CID:NNNN).
    return Array.from({ length: n }, (_, i) => ({ id: `sciweon::compound::CID:${String(i).padStart(4, '0')}` }));
}

describe('coverage cursor advances through the WHOLE corpus over runs (no O(50) ceiling)', () => {
    it('a 130-compound corpus with chunk_size 50 is fully covered in 3 runs', () => {
        const compounds = corpus(130);
        const stamps = new Map<string, string>(); // R2 stamp store (starts empty)
        let cursor: any = null;
        const everQueried = new Set<string>();

        for (let run = 0; run < 3; run++) {
            // 1. apply prior stamps (none on run 0).
            applyStampsToCompounds(compounds, stamps, TRIALS_STAMP_FIELD);
            // 2. eligibility = not fresh.
            const eligible = compounds.filter(c => isEligibleForQuery(c, TRIALS_STAMP_FIELD, 30, NOW));
            // 3. cursored slice.
            const chunk = chunkIterator(eligible, cursor, 50);
            expect(chunk.slice.length).toBeGreaterThan(0);
            // 4. "query" each (record + stamp at NOW so it becomes fresh next run).
            for (const c of chunk.slice) {
                everQueried.add(c.id);
                stamps.set(c.id, new Date(NOW).toISOString());
            }
            cursor = buildNextCursor({
                source: 'trial_linker', prev: cursor, chunkResult: chunk,
                processedCount: chunk.slice.length, totalEligible: chunk.totalEligible, chunkSize: 50,
            });
        }
        // Every one of the 130 compounds got queried within 3 runs -- the ceiling is gone.
        expect(everQueried.size).toBe(130);
    });

    it('once all stamped fresh, the next run has ZERO eligible (skip-if-fresh holds)', () => {
        const compounds = corpus(20);
        const stamps = new Map<string, string>();
        for (const c of compounds) stamps.set(c.id, new Date(NOW).toISOString());
        applyStampsToCompounds(compounds, stamps, TRIALS_STAMP_FIELD);
        const eligible = compounds.filter(c => isEligibleForQuery(c, TRIALS_STAMP_FIELD, 30, NOW));
        expect(eligible.length).toBe(0);
    });

    it('a compound whose stamp aged past the window becomes eligible again (re-query cadence)', () => {
        const compounds = corpus(5);
        const stamps = new Map<string, string>();
        // 4 fresh, 1 stale (queried 40 days ago, > 30d window).
        for (let i = 0; i < 4; i++) stamps.set(compounds[i].id, new Date(NOW - 5 * DAY).toISOString());
        stamps.set(compounds[4].id, new Date(NOW - 40 * DAY).toISOString());
        applyStampsToCompounds(compounds, stamps, TRIALS_STAMP_FIELD);
        const eligible = compounds.filter(c => isEligibleForQuery(c, TRIALS_STAMP_FIELD, 30, NOW));
        expect(eligible.map(c => c.id)).toEqual([compounds[4].id]);
    });
});
