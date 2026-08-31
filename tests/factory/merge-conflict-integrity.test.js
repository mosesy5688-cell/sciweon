// @ts-nocheck
/**
 * F0-MERGE-INTEGRITY regression guard.
 *
 * The incremental merge used `{ ...existing, ...record }`, which is
 * last-write-wins at field level: when two sources disagreed about the same
 * field of the same entity, the earlier value was destroyed. Only
 * `provenance.sources` was union-merged, so the source NAMES survived while the
 * competing VALUES did not -- a silent, unrecoverable loss that would land at
 * its worst during a post-freeze catch-up.
 *
 * THE CONTRACT THESE TESTS LOCK:
 *   1. no differing value is ever silently dropped;
 *   2. the served value is unchanged from the previous behaviour (this is a
 *      defect fix, not a re-ranking of sources);
 *   3. filling a gap is not a conflict;
 *   4. agreement is not a conflict, including across key order;
 *   5. claims accumulate across successive merges and are attributed.
 */

import { describe, it, expect } from 'vitest';
import {
    mergePreservingConflicts,
    detectFieldConflicts,
    valuesAgree,
    MAX_COMPETING_CLAIMS_PER_RECORD,
} from '../../scripts/factory/lib/merge-conflict.js';

const rec = (id, fields, source) => ({
    id,
    ...fields,
    provenance: { primary_source: source, sources: [{ source }] },
});

describe('F0-MERGE-INTEGRITY: no differing value is silently dropped', () => {
    it('retains the displaced value as an attributed competing claim', () => {
        const existing = rec('c1', { molecular_weight: 180.16 }, 'pubchem');
        const incoming = rec('c1', { molecular_weight: 180.2 }, 'chembl');

        const { merged, conflicts } = mergePreservingConflicts(existing, incoming, 'chembl');

        // Served value unchanged from the old behaviour: incoming still wins.
        expect(merged.molecular_weight).toBe(180.2);
        // But the displaced value survives, attributed to who said it.
        expect(conflicts).toHaveLength(1);
        expect(merged.has_competing_claims).toBe(true);
        expect(merged.competing_claims).toEqual([{
            field: 'molecular_weight',
            value: 180.16,
            source: 'pubchem',
            displaced_by_source: 'chembl',
            displaced_in_delta: 'chembl',
        }]);
    });

    it('THE REGRESSION: the old merge destroyed it; the new one cannot', () => {
        const existing = rec('c1', { inchi_key: 'AAA' }, 'pubchem');
        const incoming = rec('c1', { inchi_key: 'BBB' }, 'chembl');

        const oldBehaviour = { ...existing, ...incoming };
        expect(JSON.stringify(oldBehaviour)).not.toContain('AAA'); // value gone

        const { merged } = mergePreservingConflicts(existing, incoming, 'chembl');
        expect(JSON.stringify(merged)).toContain('AAA');          // value retained
    });

    it('accumulates claims across successive merges from three sources', () => {
        let cur = rec('c1', { name: 'aspirin' }, 'pubchem');
        cur = mergePreservingConflicts(cur, rec('c1', { name: 'Aspirin' }, 'chembl'), 'chembl').merged;
        cur = mergePreservingConflicts(cur, rec('c1', { name: 'ASA' }, 'dailymed'), 'dailymed').merged;

        expect(cur.name).toBe('ASA');
        const values = cur.competing_claims.map(c => c.value).sort();
        expect(values).toEqual(['Aspirin', 'aspirin']);
        expect(cur.competing_claims.map(c => c.source).sort()).toEqual(['chembl', 'pubchem']);
    });

    it('every displaced value across a many-field conflict is retained', () => {
        const existing = rec('c1', { a: 1, b: 2, c: 3 }, 'pubchem');
        const incoming = rec('c1', { a: 9, b: 8, c: 7 }, 'chembl');
        const { merged, conflicts } = mergePreservingConflicts(existing, incoming, 'chembl');
        expect(conflicts).toHaveLength(3);
        expect(merged.competing_claims.map(c => c.value).sort()).toEqual([1, 2, 3]);
    });
});

describe('F0-MERGE-INTEGRITY: what is NOT a conflict', () => {
    it('filling a previously absent field', () => {
        const { conflicts } = mergePreservingConflicts(
            rec('c1', {}, 'pubchem'), rec('c1', { logp: 1.2 }, 'chembl'), 'chembl');
        expect(conflicts).toHaveLength(0);
    });

    it('filling a null or undefined field', () => {
        for (const empty of [null, undefined]) {
            const { conflicts } = mergePreservingConflicts(
                rec('c1', { logp: empty }, 'pubchem'), rec('c1', { logp: 1.2 }, 'chembl'), 'chembl');
            expect(conflicts).toHaveLength(0);
        }
    });

    it('an incoming record that omits the field entirely', () => {
        const { merged, conflicts } = mergePreservingConflicts(
            rec('c1', { logp: 1.2 }, 'pubchem'), rec('c1', {}, 'chembl'), 'chembl');
        expect(conflicts).toHaveLength(0);
        expect(merged.logp).toBe(1.2);
    });

    it('identical values, including nested objects in a different key order', () => {
        const a = rec('c1', { x: { p: 1, q: [1, 2] } }, 'pubchem');
        const b = rec('c1', { x: { q: [1, 2], p: 1 } }, 'chembl');
        expect(valuesAgree(a.x, b.x)).toBe(true);
        expect(mergePreservingConflicts(a, b, 'chembl').conflicts).toHaveLength(0);
    });

    it('array order IS significant and does conflict', () => {
        const { conflicts } = mergePreservingConflicts(
            rec('c1', { syn: ['a', 'b'] }, 'pubchem'),
            rec('c1', { syn: ['b', 'a'] }, 'chembl'), 'chembl');
        expect(conflicts).toHaveLength(1);
    });

    it('structural keys are never claims', () => {
        const { conflicts } = mergePreservingConflicts(
            rec('c1', {}, 'pubchem'), rec('c1', {}, 'chembl'), 'chembl');
        expect(detectFieldConflicts({ id: 'c1' }, { id: 'c1' })).toHaveLength(0);
        expect(conflicts).toHaveLength(0);
    });
});

describe('F0-MERGE-INTEGRITY: existing behaviour preserved', () => {
    it('union-merges provenance sources without duplicating', () => {
        const existing = rec('c1', { a: 1 }, 'pubchem');
        const incoming = rec('c1', { a: 1 }, 'chembl');
        const { merged } = mergePreservingConflicts(existing, incoming, 'chembl');
        expect(merged.provenance.sources.map(s => s.source)).toEqual(['pubchem', 'chembl']);
    });

    it('does not mutate the inputs', () => {
        const existing = rec('c1', { a: 1 }, 'pubchem');
        const incoming = rec('c1', { a: 2 }, 'chembl');
        const before = JSON.stringify(existing);
        mergePreservingConflicts(existing, incoming, 'chembl');
        expect(JSON.stringify(existing)).toBe(before);
    });

    it('carries prior claims forward even when this merge has no conflict', () => {
        let cur = mergePreservingConflicts(
            rec('c1', { a: 1 }, 'pubchem'), rec('c1', { a: 2 }, 'chembl'), 'chembl').merged;
        cur = mergePreservingConflicts(cur, rec('c1', { b: 5 }, 'dailymed'), 'dailymed').merged;
        expect(cur.competing_claims).toHaveLength(1);
        expect(cur.competing_claims[0].value).toBe(1);
    });

    it('caps unbounded growth but records that it truncated', () => {
        let cur = rec('c1', { a: 0 }, 'pubchem');
        for (let i = 1; i <= MAX_COMPETING_CLAIMS_PER_RECORD + 5; i++) {
            cur = mergePreservingConflicts(cur, rec('c1', { a: i }, `s${i}`), `s${i}`).merged;
        }
        expect(cur.competing_claims).toHaveLength(MAX_COMPETING_CLAIMS_PER_RECORD);
        expect(cur.competing_claims_truncated).toBe(true);
        expect(cur.competing_claims_total).toBeGreaterThan(MAX_COMPETING_CLAIMS_PER_RECORD);
    });
});
