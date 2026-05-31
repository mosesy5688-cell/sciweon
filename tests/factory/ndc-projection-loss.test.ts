// @ts-nocheck
/**
 * PR-MD-1d: summarizeNdcProjectionLoss tests.
 *
 * Locks the TRUE link-loss metric: lost = NDCs that fell back AND were never
 * rescued by a parallel ingredient-projecting row. The decisive case is (c):
 * a duplicate NDC on both a projecting row and a fallback row must NOT count as
 * lost -- proving lost != raw fallback frequency.
 */

import { describe, it, expect } from 'vitest';
import { summarizeNdcProjectionLoss } from '../../scripts/factory/lib/ndc-projection-loss.js';

const meta = (pairs: [string, string][]) => new Map(pairs.map(([rxcui, tty]) => [rxcui, { tty }]));

describe('summarizeNdcProjectionLoss', () => {
    it('a) NDC that reached an ingredient -> projected, NOT lost', () => {
        const projected = new Set(['00001000001']);
        const fallback = new Map();
        const r = summarizeNdcProjectionLoss(projected, fallback, new Map());
        expect(r.distinct_projected).toBe(1);
        expect(r.distinct_fallback_only).toBe(0);
    });

    it('b) NDC only on a no-edge (BN) rxcui -> lost++', () => {
        const projected = new Set();
        const fallback = new Map([['00001000001', [{ rxcui: '1694', sab: 'MTHSPL' }]]]);
        const r = summarizeNdcProjectionLoss(projected, fallback, meta([['1694', 'BN']]));
        expect(r.distinct_fallback_only).toBe(1);
        expect(r.tty_dist).toEqual({ BN: 1 });
        expect(r.sab_dist).toEqual({ MTHSPL: 1 });
        expect(r.samples[0]).toMatchObject({ ndc: '00001000001', rxcui: '1694', tty: 'BN' });
    });

    it('c) DECISIVE: same NDC on an ingredient row AND a BN fallback row -> lost=0 (duplicate-rescue)', () => {
        // The NDC is in BOTH projected (rescued by the SCD/ingredient row) and
        // fallback (the BN row). lost MUST exclude it -> proves lost != fallback_rate.
        const projected = new Set(['00001000001']);
        const fallback = new Map([['00001000001', [{ rxcui: '1694', sab: 'RXNORM' }]]]);
        const r = summarizeNdcProjectionLoss(projected, fallback, meta([['1694', 'BN']]));
        expect(r.distinct_fallback_only).toBe(0);     // rescued, not lost
        expect(r.distinct_projected).toBe(1);
        expect(r.tty_dist).toEqual({});               // nothing counted into the loss dist
    });

    it('d) tty=null when meta has no entry; sab split RXNORM vs MTHSPL', () => {
        const projected = new Set();
        const fallback = new Map([
            ['00001000001', [{ rxcui: 'X', sab: 'RXNORM' }]],
            ['00001000002', [{ rxcui: 'Y', sab: 'MTHSPL' }]],
        ]);
        const r = summarizeNdcProjectionLoss(projected, fallback, new Map());  // empty meta
        expect(r.distinct_fallback_only).toBe(2);
        expect(r.tty_dist).toEqual({ null: 2 });
        expect(r.sab_dist).toEqual({ RXNORM: 1, MTHSPL: 1 });
    });

    it('fallback_rate_upper_bound math + empty-input safety', () => {
        const r = summarizeNdcProjectionLoss(new Set(['a', 'b', 'c']), new Map([['d', [{ rxcui: 'Z', sab: 'RXNORM' }]]]), new Map());
        expect(r.fallback_rate_upper_bound).toBe(25);  // 1 lost / (3 projected + 1 lost)
        expect(summarizeNdcProjectionLoss(new Set(), new Map(), new Map())).toMatchObject({ distinct_projected: 0, distinct_fallback_only: 0, fallback_rate_upper_bound: 0 });
    });
});
