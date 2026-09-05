// @ts-nocheck
/**
 * LANE3 test 8, the frozen L3-1 discriminating cases, and L3-3.
 *
 * Overflow is FAIL-SOFT-LOUD. The merge never throws and never calls
 * process.exit here: the stage-3 driver turns any throw from the merge into a
 * process exit and refuses to degrade, so one record at cap would halt the
 * whole cycle for every compound. Admission is SKIP-AND-CONTINUE, and the
 * three overflow keys are STICKY -- the refused items are gone forever, so a
 * later "complete" set would be a false claim of completeness.
 */

import { describe, it, expect } from 'vitest';
import {
    MAX_ITEMS_PER_FIELD, MAX_ITEMS_PER_RECORD, composeOverflow, mergeCompoundWithClaims,
} from '../../scripts/factory/lib/merge-claims-wrapper.js';
import { logMergeStatsPerFile } from '../../scripts/factory/lib/stage-3-merge.js';

const OVERFLOW = 'CLAIM_SET_INCOMPLETE_OVERFLOW';
const SRC = { source: null, status: 'unknown' };
const ID = 'sciweon::compound::CID:2244';

const claim = (path, value) => ({ path, value, side: 'previous', source: { ...SRC } });
const pres = (path, value) => ({ path, value });
const many = (path, n, tag) =>
    Array.from({ length: n }, (_, i) => claim(path, `${tag}-inherited-${i}`));
const manyPres = (path, n, tag) =>
    Array.from({ length: n }, (_, i) => pres(path, `${tag}-pres-${i}`));
const asMap = (o) => new Map(Object.entries(o));

function base(extra = {}) {
    return {
        id: ID, pubchem_cid: 2244, inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        smiles_canonical: 'CC(=O)OC1=CC=CC=C1C(=O)O',
        molecular_formula: 'C9H8O4', iupac_name: '2-acetyloxybenzoic acid',
        external_ids: { unii: 'R16CO5Y76E', sources: ['unichem'] }, ...extra,
    };
}

describe('LANE3 3i: the caps', () => {
    it('are 8 per field and 32 per record', () => {
        expect(MAX_ITEMS_PER_FIELD).toBe(8);
        expect(MAX_ITEMS_PER_RECORD).toBe(32);
    });

    it('admits at cap-1 with no overflow state', () => {
        const counters = {};
        const prev = base({ competing_claims: many('molecular_formula', 7, 'F') });
        const merged = mergeCompoundWithClaims(prev, base({ molecular_formula: null }), counters);
        expect(merged.competing_claims).toHaveLength(8);
        expect(merged.claim_set_state).toBeUndefined();
        expect(merged.claim_overflow_fields).toBeUndefined();
        expect(counters.claims.overflow_refusals).toBe(0);
    });

    it('refuses at cap, without throwing, and writes all three keys in 3e shape', () => {
        const counters = {};
        const prev = base({ competing_claims: many('molecular_formula', 8, 'F') });
        let merged;
        expect(() => {
            merged = mergeCompoundWithClaims(prev, base({ molecular_formula: null }), counters);
        }).not.toThrow();
        expect(merged.competing_claims).toHaveLength(8);
        expect(merged.claim_set_state).toBe(OVERFLOW);
        expect(merged.claim_overflow_fields).toEqual(['molecular_formula']);
        expect(merged.claim_overflow_counts).toEqual({ molecular_formula: 1 });
        expect(Object.keys(merged.claim_overflow_counts)).toEqual(merged.claim_overflow_fields);
        expect(counters.claims.overflow_refusals).toBe(1);
        expect(counters.claims.overflow_records).toBe(1);
        // A sample is a record id plus an allow-listed path. NO VALUE.
        expect(counters.claims.sample).toEqual([{ id: ID, path: 'molecular_formula' }]);
    });

    it('retains every inherited item at cap+1 and still refuses the new candidate', () => {
        const counters = {};
        const prev = base({ competing_claims: many('molecular_formula', 9, 'F') });
        const merged = mergeCompoundWithClaims(prev, base({ molecular_formula: null }), counters);
        expect(merged.competing_claims).toHaveLength(9);
        expect(merged.claim_overflow_counts).toEqual({ molecular_formula: 1 });
    });

    it('counts BOTH containers together against the per-field cap', () => {
        // 4 claims + 4 preserved on one path = 8. Counting a single container
        // would see 4 and wrongly admit.
        const counters = {};
        const prev = base({
            competing_claims: many('inchi_key', 4, 'K'),
            preserved_against_null: manyPres('inchi_key', 4, 'K'),
        });
        const merged = mergeCompoundWithClaims(prev, base({ inchi_key: null }), counters);
        expect(merged.competing_claims).toHaveLength(4);
        expect(merged.preserved_against_null).toHaveLength(4);
        expect(merged.preserved_against_null.map(e => e.value))
            .not.toContain('BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
        expect(merged.claim_overflow_counts).toEqual({ inchi_key: 1 });
        expect(counters.claims.claims_kept + counters.claims.preserved_kept).toBe(8);
    });

    it('SKIPS AND CONTINUES: a refusal on one path does not block another path', () => {
        const counters = {};
        const prev = base({
            competing_claims: many('inchi_key', 4, 'K'),
            preserved_against_null: manyPres('inchi_key', 4, 'K'),
        });
        const merged = mergeCompoundWithClaims(
            prev, base({ inchi_key: null, molecular_formula: null }), counters);
        expect(merged.claim_overflow_fields).toEqual(['inchi_key']);
        expect(merged.competing_claims)
            .toContainEqual({ path: 'molecular_formula', value: 'C9H8O4', side: 'previous', source: SRC });
        expect(counters.claims.overflow_refusals).toBe(1);
    });

    it('refuses on the RECORD cap alone, with the path far below the field cap', () => {
        const counters = {};
        const prev = base({
            competing_claims: [...many('molecular_formula', 20, 'M'), ...many('iupac_name', 12, 'I')],
        });
        const merged = mergeCompoundWithClaims(prev, base({ inchi_key: null }), counters);
        expect(merged.competing_claims).toHaveLength(32);
        expect(merged.preserved_against_null).toBeUndefined();
        expect(merged.claim_overflow_fields).toEqual(['inchi_key']);
        expect(merged.claim_overflow_counts).toEqual({ inchi_key: 1 });
    });

    it('admits at record cap-1', () => {
        const counters = {};
        const prev = base({
            competing_claims: [...many('molecular_formula', 20, 'M'), ...many('iupac_name', 11, 'I')],
        });
        const merged = mergeCompoundWithClaims(prev, base({ inchi_key: null }), counters);
        expect(merged.competing_claims).toHaveLength(31);
        expect(merged.preserved_against_null).toHaveLength(1);
        expect(merged.claim_set_state).toBeUndefined();
        expect(counters.claims.overflow_refusals).toBe(0);
    });

    it('refuses at record cap+1', () => {
        const counters = {};
        const prev = base({
            competing_claims: [...many('molecular_formula', 20, 'M'), ...many('iupac_name', 13, 'I')],
        });
        const merged = mergeCompoundWithClaims(prev, base({ inchi_key: null }), counters);
        expect(merged.competing_claims).toHaveLength(33);
        expect(merged.claim_overflow_counts).toEqual({ inchi_key: 1 });
    });

    it('is STICKY across a later merge that would otherwise fall under the cap', () => {
        const prev = base({ competing_claims: many('molecular_formula', 8, 'F') });
        const overflowed = mergeCompoundWithClaims(prev, base({ molecular_formula: null }), {});
        expect(overflowed.claim_set_state).toBe(OVERFLOW);
        const counters = {};
        const next = mergeCompoundWithClaims(overflowed, base(), counters);
        expect(counters.claims.overflow_refusals).toBe(0);
        expect(next.claim_set_state).toBe(OVERFLOW);
        expect(next.claim_overflow_fields).toEqual(['molecular_formula']);
        expect(next.claim_overflow_counts).toEqual({ molecular_formula: 1 });
    });
});

describe('LANE3 F-1 / L3-1: the cross-cycle composition rule', () => {
    // A disjoint-path case CANNOT distinguish MAX from SUM: on disjoint paths
    // sum(c,0) === max(c,0). All three cases are required.
    it('inherited 3 / current 2 on the SAME path -> 3 (kills SUM = 5)', () => {
        const r = composeOverflow(asMap({ molecular_formula: 3 }), asMap({ molecular_formula: 2 }));
        expect(r.counts).toEqual({ molecular_formula: 3 });
        expect(r.fields).toEqual(['molecular_formula']);
    });

    it('inherited 2 / current 3 on the SAME path -> 3 (kills keep-inherited = 2)', () => {
        const r = composeOverflow(asMap({ molecular_formula: 2 }), asMap({ molecular_formula: 3 }));
        expect(r.counts).toEqual({ molecular_formula: 3 });
    });

    it('disjoint paths -> UNION of fields (kills overwrite)', () => {
        const r = composeOverflow(asMap({ molecular_formula: 3 }), asMap({ iupac_name: 1 }));
        expect(r.fields).toEqual(['iupac_name', 'molecular_formula']);
        expect(r.counts).toEqual({ iupac_name: 1, molecular_formula: 3 });
        expect(Object.keys(r.counts)).toEqual(r.fields);
    });

    it('carries an inherited count through a real merge without summing it', () => {
        const prev = base({
            competing_claims: many('molecular_formula', 8, 'F'),
            claim_set_state: OVERFLOW,
            claim_overflow_fields: ['molecular_formula'],
            claim_overflow_counts: { molecular_formula: 3 },
        });
        const merged = mergeCompoundWithClaims(prev, base({ molecular_formula: null }), {});
        // max(3, 1) = 3. SUM would give 4; overwrite would give 1.
        expect(merged.claim_overflow_counts).toEqual({ molecular_formula: 3 });
    });

    it('unions a refusal on a NEW path with an inherited count on another', () => {
        const prev = base({
            competing_claims: many('molecular_formula', 8, 'F'),
            claim_set_state: OVERFLOW,
            claim_overflow_fields: ['iupac_name'],
            claim_overflow_counts: { iupac_name: 2 },
        });
        const merged = mergeCompoundWithClaims(prev, base({ molecular_formula: null }), {});
        expect(merged.claim_overflow_fields).toEqual(['iupac_name', 'molecular_formula']);
        expect(merged.claim_overflow_counts).toEqual({ iupac_name: 2, molecular_formula: 1 });
        expect(Object.keys(merged.claim_overflow_counts)).toEqual(merged.claim_overflow_fields);
    });

    it('treats a non-positive-integer inherited count as not valid inherited evidence', () => {
        const prev = base({
            claim_set_state: OVERFLOW,
            claim_overflow_fields: ['molecular_formula'],
            claim_overflow_counts: { molecular_formula: 0 },
        });
        const merged = mergeCompoundWithClaims(prev, base(), {});
        expect(merged.claim_set_state).toBe(OVERFLOW);
        expect(merged.claim_overflow_fields).toBeUndefined();
    });
});

describe('LANE3 L3-3: the stage-3 driver must EMIT the counters', () => {
    it('logs a non-zero refusal count and the id+path sample', () => {
        const counters = {};
        const prev = base({ competing_claims: many('molecular_formula', 8, 'F') });
        mergeCompoundWithClaims(prev, base({ molecular_formula: null }), counters);
        expect(counters.claims.overflow_refusals).toBe(1);

        const lines = [];
        const original = console.log;
        console.log = (...args) => { lines.push(args.join(' ')); };
        try {
            logMergeStatsPerFile({
                'compounds-enriched.jsonl': {
                    total: 1, from_current: 1, from_previous_kept: 0, replaced_by_current: 1,
                    merged_deep_total: 1, merged_deep_claims: counters.claims,
                    prev_claims_revalidate: { scanned: 2, dropped: 1, records_cleaned: 1, sample: ['CID:9'] },
                },
            });
        } finally {
            console.log = original;
        }
        const out = lines.join('\n');
        expect(out).toContain('overflow_refusals=1');
        expect(out).toContain('overflow_records=1');
        expect(out).toContain('deep_merge_claims_sample');
        expect(out).toContain(`${ID}:molecular_formula`);
        expect(out).toContain('prev_claims_revalidate: scanned=2 dropped=1 records_cleaned=1');
        // Samples carry no value, ever.
        expect(out).not.toContain('C9H8O4');
        expect(out).not.toContain('F-inherited-0');
    });
});
