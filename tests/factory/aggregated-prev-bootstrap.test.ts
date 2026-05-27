// @ts-nocheck
/**
 * PR-FDA-SRS-3c reverse-design contract: bootstrapPrevRecords must flag
 * every eligible prev record regardless of cur-cycle overlap. The original
 * PR-FDA-SRS-3 bug wired the bootstrap inside deepMergeCompound which
 * silent-skipped prev-only records (28,097 of them in F3 run 26490754894;
 * SC run 26492238083 measured unichem at 4.96% vs expected ~38.02%).
 * This suite locks the prev-load contract permanently.
 */

import { describe, it, expect } from 'vitest';
import { bootstrapPrevRecords } from '../../scripts/factory/lib/aggregated-deep-merge.js';

function makeRec(id, sources, unii, unichemMatched) {
    return {
        id,
        external_ids: {
            sources,
            unii,
            ...(unichemMatched !== undefined ? { unichem_matched: unichemMatched } : {}),
        },
    };
}

describe('PR-FDA-SRS-3c: bootstrapPrevRecords matrix', () => {
    it('1. flips baseline eligible record', () => {
        const prev = [makeRec('sciweon::compound::CID:1', ['unichem', 'chembl'], '8MJB9HSC8Q')];
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(1);
        expect(prev[0].external_ids.unichem_matched).toBe(true);
        expect(res.sample).toContain('sciweon::compound::CID:1');
    });

    it('2. idempotent on already-flagged records', () => {
        const prev = [makeRec('sciweon::compound::CID:2', ['unichem'], '8MJB9HSC8Q', true)];
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(0);
    });

    it('3. UNII null gate rejects', () => {
        const prev = [makeRec('sciweon::compound::CID:3', ['unichem'], null)];
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(0);
        expect(prev[0].external_ids.unichem_matched).toBeUndefined();
    });

    it('4. sources gate rejects when unichem not present', () => {
        const prev = [makeRec('sciweon::compound::CID:4', ['chembl', 'rxnorm'], '8MJB9HSC8Q')];
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(0);
    });

    it('5. tolerates missing external_ids without throwing', () => {
        const prev = [{ id: 'sciweon::compound::CID:5' }];
        expect(() => bootstrapPrevRecords(prev)).not.toThrow();
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(0);
    });

    it('6. sample truncated to 10 with full count returned', () => {
        const prev = Array.from({ length: 15 }, (_, i) => makeRec(`sciweon::compound::CID:${i}`, ['unichem'], '8MJB9HSC8Q'));
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(15);
        expect(res.sample.length).toBe(10);
    });

    it('7. mixed-shape precise counting (no skew)', () => {
        const prev = [
            makeRec('sciweon::compound::CID:M1', ['unichem'], '8MJB9HSC8Q'),
            makeRec('sciweon::compound::CID:M2', ['chembl'], '8MJB9HSC8Q'),
            makeRec('sciweon::compound::CID:M3', ['unichem'], null),
            makeRec('sciweon::compound::CID:M4', ['unichem'], '8MJB9HSC8Q', true),
            makeRec('sciweon::compound::CID:M5', ['unichem', 'rxnorm'], 'FOO456BAR7'),
        ];
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(2);
        expect(prev[0].external_ids.unichem_matched).toBe(true);
        expect(prev[4].external_ids.unichem_matched).toBe(true);
    });

    it('8. ANTI-REGRESSION: 100% coverage on prev-only dataset (the PR-FDA-SRS-3 bug)', () => {
        // Synthetic 50-record prev-only batch; none have any cur-cycle counterpart.
        // PR-FDA-SRS-3's misplaced call inside deepMergeCompound would have
        // flagged 0 (early-return on !current). Correct prev-load impl flags 50.
        const prev = Array.from({ length: 50 }, (_, i) =>
            makeRec(`sciweon::compound::CID:PREV_ONLY_${i}`, ['unichem'], '8MJB9HSC8Q')
        );
        const res = bootstrapPrevRecords(prev);
        expect(res.count).toBe(50);
        for (const rec of prev) expect(rec.external_ids.unichem_matched).toBe(true);
    });

    it('9. non-array input returns zero (defensive)', () => {
        expect(bootstrapPrevRecords(null).count).toBe(0);
        expect(bootstrapPrevRecords(undefined).count).toBe(0);
        expect(bootstrapPrevRecords('not-an-array').count).toBe(0);
    });
});
