// @ts-nocheck
/**
 * PR-RXN-1b cross-linker NDC->RxCUI hydration tests (2026-05-28).
 *
 * Architect-mandated 3-assertion baseline (Cont 63 + 67) + 5 extensions
 * for combination-product 1:N + degenerate paths + defensive guards.
 * Pure function test — no R2 mock needed.
 *
 * Test matrix locks `[[scope_vs_quality_validation_segregation]]` consumer-side
 * contract: fail-soft per-NDC + bucket telemetry + idempotency.
 */

import { describe, it, expect } from 'vitest';
import { hydrateLabelRxcuisFromNdcs } from '../../scripts/factory/adapter-cross-linker.js';

function makeMaps(entries) {
    const ndcToRxcuis = new Map();
    for (const [ndc, rxcuis] of entries) {
        const set = new Set(rxcuis.map(rxcui => ({ rxcui, preferred_str: `Drug ${rxcui}`, tty: 'IN', sab: 'RXNORM' })));
        ndcToRxcuis.set(ndc, set);
    }
    return { ndcToRxcuis };
}

function makeLabel(setid, ndcs, rxcui) {
    const rec = { id: `sciweon::drug_label::setid::${setid}`, setid, ndcs };
    if (rxcui !== undefined) rec.rxcui = rxcui;
    return rec;
}

describe('PR-RXN-1b: hydrateLabelRxcuisFromNdcs', () => {
    it('1. Architect A: 5 NDCs (4 mapped + 1 unmapped) -> 4 deduped RxCUIs + 1 excluded', () => {
        const maps = makeMaps([
            ['00001000001', ['IN_A']],
            ['00001000002', ['IN_B']],
            ['00001000003', ['IN_C']],
            ['00001000004', ['IN_D']],
            // 00001000099 not mapped
        ]);
        const records = [
            makeLabel('lbl1', ['00001000001', '00001000002', '00001000003', '00001000004', '00001000099']),
        ];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toEqual(['IN_A', 'IN_B', 'IN_C', 'IN_D']);
        expect(tele.labels_hydrated).toBe(1);
        expect(tele.excluded_unmapped_ndc_count).toBe(1);
        expect(tele.sample_unmapped_ndcs.some(s => s.includes('00001000099'))).toBe(true);
    });

    it('2. Architect B: 3 NDCs (1 mapped + 2 unmapped) -> 1 RxCUI + 2 excluded', () => {
        const maps = makeMaps([['00002000001', ['IN_M']]]);
        const records = [
            makeLabel('lbl2', ['00002000001', '00002000099', '00002000098']),
        ];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toEqual(['IN_M']);
        expect(tele.labels_hydrated).toBe(1);
        expect(tele.excluded_unmapped_ndc_count).toBe(2);
    });

    it('3. Architect C: idempotency on already-populated rxcui[] -> no-op', () => {
        const maps = makeMaps([['00003000001', ['IN_NEW']]]);
        const records = [
            makeLabel('lbl3', ['00003000001'], ['IN_PRE_EXISTING']),
        ];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toEqual(['IN_PRE_EXISTING']);  // unchanged
        expect(tele.labels_skipped_already_populated).toBe(1);
        expect(tele.labels_hydrated).toBe(0);
        expect(tele.excluded_unmapped_ndc_count).toBe(0);
    });

    it('4. Combination product 1:N: single NDC maps to 2 ingredients -> rxcui[] has both', () => {
        const maps = makeMaps([['00004000001', ['IN_IPRA', 'IN_ALB']]]);
        const records = [makeLabel('combivent', ['00004000001'])];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toEqual(['IN_ALB', 'IN_IPRA']);  // sorted
        expect(tele.labels_hydrated).toBe(1);
        expect(tele.excluded_unmapped_ndc_count).toBe(0);
    });

    it('5. Multi-NDC same ingredient: 3 NDCs all map to same single rxcui -> 1 deduped RxCUI', () => {
        // Typical for different package sizes / dosage forms of same drug.
        const maps = makeMaps([
            ['00005000001', ['IN_X']],
            ['00005000002', ['IN_X']],
            ['00005000003', ['IN_X']],
        ]);
        const records = [makeLabel('lbl5', ['00005000001', '00005000002', '00005000003'])];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toEqual(['IN_X']);
        expect(tele.labels_hydrated).toBe(1);
    });

    it('6. All-unmapped zero-match: no destructive write on rxcui field', () => {
        const maps = makeMaps([['00099999999', ['IN_NEVER']]]);
        const records = [makeLabel('lbl6', ['00006000001', '00006000002', '00006000003'])];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toBeUndefined();  // not mutated when no match
        expect(tele.labels_zero_match).toBe(1);
        expect(tele.excluded_unmapped_ndc_count).toBe(3);
        expect(tele.labels_hydrated).toBe(0);
    });

    it('7. Non-drug-label passthrough: atc_class records ignored', () => {
        const maps = makeMaps([['00007000001', ['IN_DRUG']]]);
        const records = [
            { id: 'sciweon::atc_class::C01AB', level5: 'C01AB', ndcs: ['00007000001'] },  // not a drug_label
            makeLabel('lbl7', ['00007000001']),
        ];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toBeUndefined();  // atc untouched
        expect(records[1].rxcui).toEqual(['IN_DRUG']);
        expect(tele.labels_hydrated).toBe(1);
    });

    it('8. ANTI-REGRESSION: pure function never throws on malformed NDC values', () => {
        const maps = makeMaps([['00008000001', ['IN_OK']]]);
        const records = [
            // Mix of valid + null + undefined + empty string + non-string in ndcs[].
            makeLabel('lbl8', ['00008000001', null, undefined, '', 12345]),
        ];
        expect(() => hydrateLabelRxcuisFromNdcs(records, maps)).not.toThrow();
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        // 2nd call after 1st mutated rxcui -> idempotency triggers
        expect(tele.labels_skipped_already_populated).toBe(1);
    });

    it('9. Defensive: non-array adapterRecords returns zero telemetry without throw', () => {
        expect(() => hydrateLabelRxcuisFromNdcs(null, makeMaps([]))).not.toThrow();
        expect(() => hydrateLabelRxcuisFromNdcs(undefined, makeMaps([]))).not.toThrow();
        const tele = hydrateLabelRxcuisFromNdcs('not-an-array', makeMaps([]));
        expect(tele.labels_hydrated).toBe(0);
        expect(tele.labels_with_ndcs).toBe(0);
    });

    it('10. ANTI-REGRESSION: empty ndcs[] on drug_label skipped (no telemetry pollution)', () => {
        const records = [makeLabel('lbl_empty', [])];
        const tele = hydrateLabelRxcuisFromNdcs(records, makeMaps([]));
        expect(tele.labels_with_ndcs).toBe(0);
        expect(tele.labels_hydrated).toBe(0);
    });

    it('11. PR-RXN-1b-ndc-normalize: HIPAA-segmented label NDCs hydrate against 11-digit map keys', () => {
        // DailyMed v2 fetcher emits 5-3-2 / 5-4-1 segmented NDCs (e.g.
        // "70771-1953-1"); RxNorm bulk map keys are 11-digit. Without
        // normalization at the lookup boundary 100% miss -> 0% cross-link
        // floor. This test locks the fix.
        const maps = makeMaps([
            ['70771195301', ['IN_SEG_541']],    // matches "70771-1953-1" 5-4-1
            ['82046060901', ['IN_SEG_532']],    // matches "82046-609-01" 5-3-2
            ['00042022001', ['IN_SEG_442']],    // matches "0042-0220-01" 4-4-2
        ]);
        const records = [makeLabel('lbl_segmented', ['70771-1953-1', '82046-609-01', '0042-0220-01'])];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toEqual(['IN_SEG_442', 'IN_SEG_532', 'IN_SEG_541']);
        expect(tele.labels_hydrated).toBe(1);
        expect(tele.malformed_ndc_count).toBe(0);
        expect(tele.unmapped_ndc_count).toBe(0);
        expect(tele.excluded_unmapped_ndc_count).toBe(0);
    });

    it('12. PR-RXN-1b-ndc-normalize: telemetry distinguishes malformed (bad shape) vs unmapped (good shape, no hit)', () => {
        const maps = makeMaps([['00012000001', ['IN_OK']]]);
        const records = [
            // 1 valid (normalizes + hits) + 1 unmapped (normalizes, no hit) + 2 malformed (cannot normalize)
            makeLabel('lbl_mixed', ['00012000001', '99999-999-99', 'NOT-AN-NDC', '00012']),
        ];
        const tele = hydrateLabelRxcuisFromNdcs(records, maps);
        expect(records[0].rxcui).toEqual(['IN_OK']);
        expect(tele.labels_hydrated).toBe(1);
        expect(tele.malformed_ndc_count).toBe(2);   // 'NOT-AN-NDC' + '00012'
        expect(tele.unmapped_ndc_count).toBe(1);    // '99999-999-99' normalizes to '99999099999' but not in map
        expect(tele.excluded_unmapped_ndc_count).toBe(3);  // back-compat sum
        // Samples carry tags for downstream diagnostic loop
        const tagged = tele.sample_unmapped_ndcs;
        expect(tagged.some(s => s.startsWith('[MALFORMED]'))).toBe(true);
        expect(tagged.some(s => s.startsWith('[UNMAPPED]'))).toBe(true);
    });
});
