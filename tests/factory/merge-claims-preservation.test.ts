// @ts-nocheck
/**
 * LANE3 tests 2, 3, 4, 5, 6, 7, 9, 10 and 11.
 *
 * The E-1 split is the ruling that unblocked this lane. inchi_key and
 * smiles_canonical sit in STRUCTURAL_PRESERVE_FIELDS, so an incoming null
 * loses and the previous value IS the winner -- a genuine preservation.
 * molecular_formula and iupac_name sit in neither preserve list, so the blind
 * spread lets the incoming null win and the previous value is DESTROYED --
 * that is a competing claim and must not be called preserved.
 */

import { describe, it, expect } from 'vitest';
import { mergeCompoundWithClaims } from '../../scripts/factory/lib/merge-claims-wrapper.js';
import { revalidatePrevClaims } from '../../scripts/factory/lib/merge-claims-revalidate.js';
import { CLAIMABLE_PATHS } from '../../scripts/factory/lib/merge-claims-canonical.js';

const SRC = { source: null, status: 'unknown' };
const PRESERVED_PATHS = ['inchi_key', 'smiles_canonical'];
const CLAIM_PATHS = ['molecular_formula', 'iupac_name'];
const ALL_PATHS = [...PRESERVED_PATHS, ...CLAIM_PATHS];

const claim = (path, value, side = 'previous') => ({
    path, value, side, source: { source: null, status: 'unknown' },
});
const pres = (path, value) => ({ path, value });

function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) out[k] = clone(v[k]);
        return out;
    }
    return v;
}

function base(extra = {}) {
    return {
        id: 'sciweon::compound::CID:2244',
        pubchem_cid: 2244,
        inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        smiles_canonical: 'CC(=O)OC1=CC=CC=C1C(=O)O',
        molecular_formula: 'C9H8O4',
        iupac_name: '2-acetyloxybenzoic acid',
        external_ids: { unii: 'R16CO5Y76E', sources: ['unichem'] },
        ...extra,
    };
}

describe('LANE3 3a: the four frozen paths', () => {
    it('are exactly the four names, in the frozen order', () => {
        expect([...CLAIMABLE_PATHS]).toEqual([
            'inchi_key', 'smiles_canonical', 'molecular_formula', 'iupac_name',
        ]);
    });
});

describe('LANE3 E-1: the split, per path (test 2)', () => {
    for (const p of PRESERVED_PATHS) {
        it(`${p}: incoming null yields preserved_against_null and NO claim`, () => {
            const prev = base();
            const merged = mergeCompoundWithClaims(prev, base({ [p]: null }), {});
            expect(merged.preserved_against_null).toEqual([{ path: p, value: prev[p] }]);
            expect(merged.competing_claims).toBeUndefined();
            expect(merged[p]).toBe(prev[p]);
        });
    }
    for (const p of CLAIM_PATHS) {
        it(`${p}: incoming null yields competing_claims and NO preserved entry`, () => {
            const prev = base();
            const merged = mergeCompoundWithClaims(prev, base({ [p]: null }), {});
            expect(merged.competing_claims).toEqual([
                { path: p, value: prev[p], side: 'previous', source: SRC },
            ]);
            expect(merged.preserved_against_null).toBeUndefined();
            // The winner is null: the previous value really was destroyed.
            expect(merged[p]).toBeNull();
        });
    }
});

describe('LANE3 3b: the four preservation conditions', () => {
    for (const p of ALL_PATHS) {
        it(`a MISSING incoming ${p} is never a preservation event (test 3)`, () => {
            const current = base();
            delete current[p];
            const merged = mergeCompoundWithClaims(base(), current, {});
            expect(merged.preserved_against_null).toBeUndefined();
        });
    }

    it('the equal-to-winner filter never deletes a preserved entry (test 4)', () => {
        // For the two structural paths the preserved value ALWAYS equals the
        // winner, so a filter applied to both containers would empty exactly
        // the two paths that actually preserve.
        const prev = base();
        const merged = mergeCompoundWithClaims(
            prev, base({ inchi_key: null, smiles_canonical: null }), {});
        expect(merged.preserved_against_null).toHaveLength(2);
        for (const p of PRESERVED_PATHS) {
            expect(merged.preserved_against_null).toContainEqual({ path: p, value: prev[p] });
            expect(merged[p]).toBe(prev[p]);
        }
        expect(merged.competing_claims).toBeUndefined();
    });
});

describe('LANE3 3d.3: field_sources (test 5)', () => {
    it('is claim-bound and sparse, and is never written for a preserved path', () => {
        const prev = base({ provenance: { primary_source: 'pubchem' }, source: 'unichem' });
        const merged = mergeCompoundWithClaims(
            prev, base({ inchi_key: null, molecular_formula: null }), {});
        expect(Object.keys(merged.field_sources)).toEqual(['molecular_formula']);
        expect(merged.preserved_against_null).toEqual([{ path: 'inchi_key', value: prev.inchi_key }]);
        expect(merged.field_sources.inchi_key).toBeUndefined();
        for (const v of Object.values(merged.field_sources)) expect(v).toEqual(SRC);
    });

    it('never promotes a container- or record-level source', () => {
        const prev = base({ provenance: { primary_source: 'pubchem' } });
        const merged = mergeCompoundWithClaims(prev, base({ iupac_name: null }), {});
        const asText = JSON.stringify(merged.field_sources);
        expect(asText).not.toContain('pubchem');
        expect(asText).not.toContain('unichem');
        expect(asText).not.toContain('"status":"known"');
        expect(merged.competing_claims.every(c => c.source.source === null)).toBe(true);
    });
});

describe('LANE3 3h: inherited re-validation (test 6)', () => {
    it('drops bad inherited entries in BOTH containers and counts every drop', () => {
        const counters = {};
        const prev = base({
            competing_claims: [
                claim('molecular_formula', 'C9H8O5'),
                claim('pubchem_cid', 2244),
                { path: 'iupac_name', value: 'shape is wrong' },
                claim('iupac_name', null),
                claim('iupac_name', Number.POSITIVE_INFINITY),
                claim('molecular_formula', 'C9H8O5', 'incoming'),
            ],
            preserved_against_null: [
                pres('inchi_key', 'KEEPKEYAAAAAAA-UHFFFAOYSA-N'),
                pres('kegg_drug_id', 'D00109'),
                { path: 'smiles_canonical', value: 'CCO', side: 'previous' },
                pres('smiles_canonical', ''),
            ],
            field_sources: {
                molecular_formula: { source: null, status: 'unknown' },
                iupac_name: { source: 'pubchem', status: 'known' },
            },
        });
        const merged = mergeCompoundWithClaims(prev, base(), counters);
        expect(counters.claims.revalidate_drops).toBe(9);
        expect(merged.competing_claims).toEqual([claim('molecular_formula', 'C9H8O5')]);
        // preserved_against_null is validated on shape / allow-list / legality /
        // dedup ONLY -- never re-derived against today's winner.
        expect(merged.preserved_against_null)
            .toEqual([pres('inchi_key', 'KEEPKEYAAAAAAA-UHFFFAOYSA-N')]);
        expect(Object.keys(merged.field_sources)).toEqual(['molecular_formula']);
    });
});

describe('LANE3 3j: the prev-load-boundary pass (test 7)', () => {
    it('cleans a PREV-ONLY record and changes no winner', () => {
        const rec = base({
            id: 'sciweon::compound::CID:9999',
            competing_claims: [claim('molecular_formula', 'C9H8O5'), claim('pubchem_cid', 1)],
            preserved_against_null: [pres('inchi_key', 'AAAAAAAAAAAAAA-UHFFFAOYSA-N'), pres('nope', 'x')],
            field_sources: { molecular_formula: SRC, nope: SRC },
        });
        const winnersBefore = ALL_PATHS.map(p => rec[p]);
        const stats = revalidatePrevClaims([rec]);
        expect(stats).toEqual({
            scanned: 1, dropped: 3, records_cleaned: 1,
            sample: ['sciweon::compound::CID:9999'],
        });
        expect(rec.competing_claims).toEqual([claim('molecular_formula', 'C9H8O5')]);
        expect(rec.preserved_against_null)
            .toEqual([pres('inchi_key', 'AAAAAAAAAAAAAA-UHFFFAOYSA-N')]);
        expect(Object.keys(rec.field_sources)).toEqual(['molecular_formula']);
        expect(ALL_PATHS.map(p => rec[p])).toEqual(winnersBefore);
    });

    it('never creates a container key on a record that carries none', () => {
        const rec = base();
        const before = JSON.stringify(rec);
        const stats = revalidatePrevClaims([rec]);
        expect(JSON.stringify(rec)).toBe(before);
        expect(stats).toEqual({ scanned: 1, dropped: 0, records_cleaned: 0, sample: [] });
    });
});

describe('LANE3 3h: dedup, deletion and idempotence', () => {
    it('filters an inherited claim that now equals today\'s winner (test 9)', () => {
        const prev = base({ competing_claims: [claim('molecular_formula', 'C9H8O4')] });
        const merged = mergeCompoundWithClaims(prev, base(), {});
        expect(merged.molecular_formula).toBe('C9H8O4');
        expect(merged.competing_claims).toBeUndefined();
    });

    it('dedups on path+value and resolves the collision FIELD-WISE (test 9)', () => {
        const prev = base({ competing_claims: [claim('iupac_name', 'alt name', 'incoming')] });
        const current = base({ competing_claims: [claim('iupac_name', 'alt name', 'previous')] });
        const merged = mergeCompoundWithClaims(prev, current, {});
        expect(merged.competing_claims).toEqual([claim('iupac_name', 'alt name', 'previous')]);
    });

    it('DELETES inherited container keys that are now empty, keeping the overflow keys (test 10)', () => {
        const prev = base({
            competing_claims: [claim('pubchem_cid', 1)],
            preserved_against_null: [pres('nope', 'x')],
            field_sources: { nope: SRC },
            claim_set_state: 'CLAIM_SET_INCOMPLETE_OVERFLOW',
            claim_overflow_fields: ['iupac_name'],
            claim_overflow_counts: { iupac_name: 2 },
        });
        const merged = mergeCompoundWithClaims(prev, base(), {});
        expect('competing_claims' in merged).toBe(false);
        expect('preserved_against_null' in merged).toBe(false);
        expect('field_sources' in merged).toBe(false);
        expect(merged.claim_set_state).toBe('CLAIM_SET_INCOMPLETE_OVERFLOW');
        expect(merged.claim_overflow_fields).toEqual(['iupac_name']);
        expect(merged.claim_overflow_counts).toEqual({ iupac_name: 2 });
    });

    it('merging a record with itself yields no claims and no attribution (test 11)', () => {
        const rec = base();
        const merged = mergeCompoundWithClaims(clone(rec), clone(rec), {});
        expect(merged.competing_claims).toBeUndefined();
        expect(merged.preserved_against_null).toBeUndefined();
        expect(merged.field_sources).toBeUndefined();
    });

    it('merging twice is canonical-string identical to merging once (test 11)', () => {
        const prev = base({ competing_claims: [claim('iupac_name', 'alt name')] });
        const once = mergeCompoundWithClaims(
            prev, base({ molecular_formula: null, iupac_name: null }), {});
        const twice = mergeCompoundWithClaims(clone(once), clone(once), {});
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    });
});
