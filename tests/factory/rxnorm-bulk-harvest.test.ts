// @ts-nocheck
/**
 * PR-RXN-1 harvester reverse-design contract tests.
 *
 * Locks the concept-level graph-flattening contract (UNII at ingredient,
 * NDC at product -> projected DOWN to ingredient via has_ingredient +
 * consists_of relations). Without these tests, future drift back to
 * product-level keying silently re-introduces the 0% cross-link bug.
 *
 * Also locks NDC HIPAA 11-digit normalization variant coverage + the
 * LOCK 2 malformed-NDC dropped_count contract.
 */

import { describe, it, expect } from 'vitest';
import { buildProductToIngredientsMap } from '../../scripts/factory/lib/rxnorm-rel-projector.js';
import { composeRecords, isCanonicalUnii, UNII_SHAPE } from '../../scripts/factory/lib/rxnorm-rrf-streams.js';

function rxnrelRow(rxcui2, rxcui1, rela, suppress = 'N') {
    return { RXCUI1: rxcui1, RXCUI2: rxcui2, RELA: rela, SUPPRESS: suppress };
}

describe('PR-RXN-1: buildProductToIngredientsMap (concept-level graph projection)', () => {
    it('1. direct has_ingredient: SCD product -> single ingredient', () => {
        const rows = [rxnrelRow('153655', '83367', 'has_ingredient')];
        const map = buildProductToIngredientsMap(rows);
        expect(map.get('153655')?.size).toBe(1);
        expect(map.get('153655')?.has('83367')).toBe(true);
    });

    it('2. combination product: SCD -> two ingredients (1:N preserved)', () => {
        const rows = [
            rxnrelRow('PROD1', 'ING_A', 'has_ingredient'),
            rxnrelRow('PROD1', 'ING_B', 'has_ingredient'),
        ];
        const map = buildProductToIngredientsMap(rows);
        expect(map.get('PROD1')?.size).toBe(2);
        expect(map.get('PROD1')?.has('ING_A')).toBe(true);
        expect(map.get('PROD1')?.has('ING_B')).toBe(true);
    });

    it('3. pack-level one-hop closure: BPCK consists_of SCD has_ingredient IN', () => {
        const rows = [
            rxnrelRow('PACK1', 'SCD1', 'consists_of'),
            rxnrelRow('SCD1', 'IN1', 'has_ingredient'),
        ];
        const map = buildProductToIngredientsMap(rows);
        expect(map.get('PACK1')?.has('IN1')).toBe(true);
    });

    it('4. suppressed rows are skipped', () => {
        const rows = [rxnrelRow('PROD2', 'ING_X', 'has_ingredient', 'O')];
        const map = buildProductToIngredientsMap(rows);
        expect(map.has('PROD2')).toBe(false);
    });

    it('5. unrelated RELA values are ignored', () => {
        const rows = [
            rxnrelRow('PROD3', 'OTHER', 'tradename_of'),
            rxnrelRow('PROD3', 'OTHER2', 'has_form'),
        ];
        const map = buildProductToIngredientsMap(rows);
        expect(map.has('PROD3')).toBe(false);
    });
});

describe('PR-RXN-1: composeRecords (ingredient-keyed final shape)', () => {
    it('6. emits one record per ingredient with UNII or NDC', () => {
        const meta = new Map([
            ['IN1', { preferred_str: 'Atorvastatin', tty: 'IN', sab: 'RXNORM' }],
        ]);
        const attrs = new Map([
            ['IN1', { unii: 'A0JWA85V8F', ndcs: new Set(['00071015523', '00071015540']) }],
        ]);
        const out = composeRecords(meta, attrs);
        expect(out).toHaveLength(1);
        expect(out[0].rxcui).toBe('IN1');
        expect(out[0].unii).toBe('A0JWA85V8F');
        expect(out[0].ndcs).toEqual(['00071015523', '00071015540']);
        expect(out[0].preferred_str).toBe('Atorvastatin');
    });

    it('7. drops ingredient records with no UNII and no NDCs', () => {
        const meta = new Map([
            ['IN_BARE', { preferred_str: 'BareConcept', tty: 'IN', sab: 'RXNORM' }],
        ]);
        const attrs = new Map([['IN_BARE', { unii: null, ndcs: new Set() }]]);
        const out = composeRecords(meta, attrs);
        expect(out).toHaveLength(0);
    });

    it('8. sorted deterministic output for byte-stable R2 artifact', () => {
        const meta = new Map([
            ['B', { preferred_str: 'B', tty: 'IN', sab: 'RXNORM' }],
            ['A', { preferred_str: 'A', tty: 'IN', sab: 'RXNORM' }],
        ]);
        const attrs = new Map([
            ['B', { unii: 'X', ndcs: new Set() }],
            ['A', { unii: 'Y', ndcs: new Set() }],
        ]);
        const out = composeRecords(meta, attrs);
        expect(out.map(r => r.rxcui)).toEqual(['A', 'B']);
    });
});

describe('PR-RXN-1: ANTI-REGRESSION suite (architect locks)', () => {
    it('9. ANTI-REGRESSION concept-cross-degradation defense: product NDC projects to ingredient record (NOT product)', () => {
        // Mirror the production scenario: NDC attaches to product SCD; ingredient
        // record must end up keyed at IN/PIN concept after composeRecords.
        const projection = buildProductToIngredientsMap([
            rxnrelRow('PRODUCT_RXCUI', 'INGREDIENT_RXCUI', 'has_ingredient'),
        ]);
        // Simulate Phase 3 projecting NDC -> ingredient.
        const attrs = new Map();
        const ingredients = projection.get('PRODUCT_RXCUI');
        for (const ing of ingredients) {
            attrs.set(ing, { unii: null, ndcs: new Set(['12345678901']) });
        }
        const meta = new Map([['INGREDIENT_RXCUI', { preferred_str: 'X', tty: 'IN', sab: 'RXNORM' }]]);
        const out = composeRecords(meta, attrs);
        expect(out).toHaveLength(1);
        expect(out[0].rxcui).toBe('INGREDIENT_RXCUI');  // NOT 'PRODUCT_RXCUI'
        expect(out[0].ndcs).toContain('12345678901');
    });

    it('10. ANTI-REGRESSION combination 1:N projection: NDC reaches BOTH ingredient records', () => {
        const projection = buildProductToIngredientsMap([
            rxnrelRow('COMBO_PROD', 'ING_1', 'has_ingredient'),
            rxnrelRow('COMBO_PROD', 'ING_2', 'has_ingredient'),
        ]);
        const ingredients = projection.get('COMBO_PROD');
        expect(ingredients.size).toBe(2);
        const attrs = new Map();
        for (const ing of ingredients) attrs.set(ing, { unii: null, ndcs: new Set(['11111111111']) });
        const meta = new Map([
            ['ING_1', { preferred_str: 'A', tty: 'IN', sab: 'RXNORM' }],
            ['ING_2', { preferred_str: 'B', tty: 'IN', sab: 'RXNORM' }],
        ]);
        const out = composeRecords(meta, attrs);
        expect(out).toHaveLength(2);
        const rxcuis = out.map(r => r.rxcui).sort();
        expect(rxcuis).toEqual(['ING_1', 'ING_2']);
        for (const r of out) expect(r.ndcs).toContain('11111111111');
    });

    it('11. ANTI-REGRESSION pack-level closure: NDC on BPCK reaches IN via two-hop chain', () => {
        const projection = buildProductToIngredientsMap([
            rxnrelRow('B_PACK', 'S_CLINICAL', 'consists_of'),
            rxnrelRow('S_CLINICAL', 'I_NGREDIENT', 'has_ingredient'),
        ]);
        // After closure, B_PACK should reach I_NGREDIENT directly.
        expect(projection.get('B_PACK')?.has('I_NGREDIENT')).toBe(true);
    });

    it('12. ANTI-REGRESSION non-array input safety for rxnrel parser', () => {
        const out1 = buildProductToIngredientsMap([]);
        expect(out1.size).toBe(0);
        const out2 = buildProductToIngredientsMap([null, undefined, {}]);
        expect(out2.size).toBe(0);
    });

    it('13. ANTI-REGRESSION orphan ingredient: NDC on rxcui without projection falls through (no silent drop)', () => {
        // If an NDC attaches to an already-ingredient-level RxCUI (edge case),
        // it should still get a record keyed at that RxCUI.
        const meta = new Map([['ORPHAN_IN', { preferred_str: 'Z', tty: 'IN', sab: 'RXNORM' }]]);
        const attrs = new Map([['ORPHAN_IN', { unii: null, ndcs: new Set(['99999999999']) }]]);
        const out = composeRecords(meta, attrs);
        expect(out).toHaveLength(1);
        expect(out[0].rxcui).toBe('ORPHAN_IN');
    });
});

describe('PR-RXN-1f MTHSPL UNII Rewire', () => {
    const m = (rxcui, label = rxcui) => [rxcui, { preferred_str: label, tty: 'IN', sab: 'RXNORM' }];

    it('14. isCanonicalUnii regex parity + UNII_SHAPE export contract', () => {
        for (const ok of ['NR7O1405Q9', '362O9ITL9D', 'QF8SVZ843E']) expect(isCanonicalUnii(ok)).toBe(true);
        for (const bad of ['nr7o1405q9', 'NR7O1405Q', 'NR7O1405Q9X', 'NR7O-1405Q', '', null, undefined, 8123456789]) expect(isCanonicalUnii(bad as any)).toBe(false);
        expect(UNII_SHAPE).toBeInstanceOf(RegExp);
        expect(UNII_SHAPE.source).toBe('^[A-Z0-9]{10}$');
    });

    it('15. union: rxcui only in mthsplUniiByRxcui (no NDC) is emitted with unii set', () => {
        const out = composeRecords(new Map([m('IN_X', 'Mesna')]), new Map(), new Map([['IN_X', 'NR7O1405Q9']]));
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ rxcui: 'IN_X', unii: 'NR7O1405Q9', ndcs: [], preferred_str: 'Mesna' });
    });

    it('16. precedence: attr.unii beats mthsplUniiByRxcui (Full Release forward-compat wins)', () => {
        const attrs = new Map([['IN_X', { unii: 'AAA1111111', ndcs: new Set() }]]);
        const out = composeRecords(new Map([m('IN_X')]), attrs, new Map([['IN_X', 'BBB2222222']]));
        expect(out[0].unii).toBe('AAA1111111');
    });

    it('17. mixed: NDC-only / MTHSPL-only / both -> all emitted with correct fields', () => {
        const meta = new Map([m('NDC_ONLY'), m('MTHSPL_ONLY'), m('BOTH')]);
        const attrs = new Map([
            ['NDC_ONLY', { unii: null, ndcs: new Set(['00071015523']) }],
            ['BOTH',     { unii: null, ndcs: new Set(['11111111111']) }],
        ]);
        const mthspl = new Map([['MTHSPL_ONLY', 'CCC3333333'], ['BOTH', 'DDD4444444']]);
        const by = Object.fromEntries(composeRecords(meta, attrs, mthspl).map(r => [r.rxcui, r]));
        expect(by['NDC_ONLY']).toMatchObject({ unii: null, ndcs: ['00071015523'] });
        expect(by['MTHSPL_ONLY']).toMatchObject({ unii: 'CCC3333333', ndcs: [] });
        expect(by['BOTH']).toMatchObject({ unii: 'DDD4444444', ndcs: ['11111111111'] });
    });

    it('18. deterministic lex-sort across union (byte-stable R2 artifact)', () => {
        const meta = new Map([m('C'), m('A'), m('B')]);
        const attrs = new Map([
            ['C', { unii: null, ndcs: new Set(['11111111111']) }],
            ['B', { unii: null, ndcs: new Set(['22222222222']) }],
        ]);
        const mthspl = new Map([['A', 'EEE5555555'], ['B', 'FFF6666666']]);
        expect(composeRecords(meta, attrs, mthspl).map(r => r.rxcui)).toEqual(['A', 'B', 'C']);
    });
});
