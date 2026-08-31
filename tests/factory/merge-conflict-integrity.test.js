// @ts-nocheck
/**
 * F0-MERGE-INTEGRITY regression guard.
 *
 * The incremental merge used `{ ...existing, ...record }`, which is
 * last-write-wins at field level: when two sources disagreed about the same
 * field of the same entity, the earlier value was destroyed. Only
 * `provenance.sources` was union-merged, so the source NAMES survived while the
 * competing VALUES did not.
 *
 * THE CONTRACT THESE TESTS LOCK:
 *   1. no differing value is ever silently dropped;
 *   2. an incoming null/undefined does NOT destroy a real value;
 *   3. claims from BOTH inputs survive;
 *   4. field attribution is never guessed from a record-level source;
 *   5. overflow FAILS rather than truncating evidence;
 *   6. a value that is being served is not also listed as displaced;
 *   7. the served value is unchanged from the previous behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
    mergePreservingConflicts,
    detectFieldConflicts,
    valuesAgree,
    fieldSource,
    MergeClaimOverflowError,
    MAX_COMPETING_CLAIMS_PER_RECORD,
} from '../../scripts/factory/lib/merge-conflict.js';

// Record with FIELD-LEVEL attribution, which is the only kind that counts.
const rec = (id, fields, source) => ({
    id,
    ...fields,
    field_sources: Object.fromEntries(Object.keys(fields).map(k => [k, source])),
    provenance: { primary_source: source, sources: [{ source }] },
});

// Record with only RECORD-level provenance -- attribution must NOT be guessed.
const unattributed = (id, fields, source) => ({
    id, ...fields, provenance: { primary_source: source, sources: [{ source }] },
});

describe('no differing value is silently dropped', () => {
    it('retains the displaced value as an attributed competing claim', () => {
        const { merged, conflicts } = mergePreservingConflicts(
            rec('c1', { molecular_weight: 180.16 }, 'pubchem'),
            rec('c1', { molecular_weight: 180.2 }, 'chembl'), 'chembl');
        expect(merged.molecular_weight).toBe(180.2);   // winner unchanged
        expect(conflicts).toHaveLength(1);
        expect(merged.competing_claims).toEqual([{
            field: 'molecular_weight', value: 180.16, source: 'pubchem',
            source_attribution: 'field_level', displaced_in_delta: 'chembl',
        }]);
    });

    it('THE REGRESSION: the old merge destroyed it; the new one cannot', () => {
        const existing = rec('c1', { inchi_key: 'AAA' }, 'pubchem');
        const incoming = rec('c1', { inchi_key: 'BBB' }, 'chembl');
        expect(JSON.stringify({ ...existing, ...incoming })).not.toContain('AAA');
        expect(JSON.stringify(mergePreservingConflicts(existing, incoming, 'chembl').merged))
            .toContain('AAA');
    });

    it('every displaced value across a many-field conflict is retained', () => {
        const { merged, conflicts } = mergePreservingConflicts(
            rec('c1', { a: 1, b: 2, c: 3 }, 'pubchem'),
            rec('c1', { a: 9, b: 8, c: 7 }, 'chembl'), 'chembl');
        expect(conflicts).toHaveLength(3);
        expect(merged.competing_claims.map(c => c.value).sort()).toEqual([1, 2, 3]);
    });
});

describe('CORRECTION 1 -- an empty incoming value must not destroy a real one', () => {
    it('null and undefined do not overwrite; the event is recorded', () => {
        for (const empty of [null, undefined]) {
            const { merged, nullPreserved } = mergePreservingConflicts(
                rec('c1', { logp: 1.2 }, 'pubchem'),
                { id: 'c1', logp: empty, provenance: { primary_source: 'chembl' } }, 'chembl');
            expect(merged.logp).toBe(1.2);                       // NOT destroyed
            expect(nullPreserved).toHaveLength(1);
            expect(merged.preserved_against_null).toEqual([
                { field: 'logp', preserved_in_delta: 'chembl' }]);
            // Absence is not a retraction, so it is not a competing claim either.
            expect(merged.competing_claims).toBeUndefined();
        }
    });

    it('the old blind spread DID destroy it -- proof the guard is load-bearing', () => {
        const existing = rec('c1', { logp: 1.2 }, 'pubchem');
        const incoming = { id: 'c1', logp: null };
        expect({ ...existing, ...incoming }.logp).toBeNull();     // old behaviour
        expect(mergePreservingConflicts(existing, incoming, 'x').merged.logp).toBe(1.2);
    });

    it('null may still FILL a field that was absent or empty', () => {
        const { merged } = mergePreservingConflicts(
            rec('c1', {}, 'pubchem'), { id: 'c1', logp: null }, 'chembl');
        expect(merged.logp).toBeNull();
    });
});

describe('CORRECTION 2 -- claims from BOTH inputs survive', () => {
    it('an incoming record arriving with its own claims does not lose them', () => {
        const existing = rec('c1', { a: 1 }, 'pubchem');
        const incoming = {
            ...rec('c1', { a: 2 }, 'chembl'),
            competing_claims: [{ field: 'b', value: 'from-incoming', source: 'dailymed',
                source_attribution: 'field_level', displaced_in_delta: 'dailymed' }],
        };
        const { merged } = mergePreservingConflicts(existing, incoming, 'chembl');
        const values = merged.competing_claims.map(c => c.value).sort();
        expect(values).toEqual([1, 'from-incoming']);
    });

    it('carries prior claims forward even when this merge has no conflict', () => {
        let cur = mergePreservingConflicts(
            rec('c1', { a: 1 }, 'pubchem'), rec('c1', { a: 2 }, 'chembl'), 'chembl').merged;
        cur = mergePreservingConflicts(cur, rec('c1', { b: 5 }, 'dailymed'), 'dailymed').merged;
        expect(cur.competing_claims).toHaveLength(1);
        expect(cur.competing_claims[0].value).toBe(1);
    });

    it('accumulates across three sources with attribution', () => {
        let cur = rec('c1', { name: 'aspirin' }, 'pubchem');
        cur = mergePreservingConflicts(cur, rec('c1', { name: 'Aspirin' }, 'chembl'), 'chembl').merged;
        cur = mergePreservingConflicts(cur, rec('c1', { name: 'ASA' }, 'dailymed'), 'dailymed').merged;
        expect(cur.name).toBe('ASA');
        expect(cur.competing_claims.map(c => c.source).sort()).toEqual(['chembl', 'pubchem']);
    });
});

describe('CORRECTION 3 -- attribution is never guessed', () => {
    it('a record-level primary_source does NOT attribute a field', () => {
        const { merged } = mergePreservingConflicts(
            unattributed('c1', { a: 1 }, 'pubchem'),
            unattributed('c1', { a: 2 }, 'chembl'), 'chembl');
        expect(merged.competing_claims[0].source).toBeNull();
        expect(merged.competing_claims[0].source_attribution).toBe('unattributed');
    });

    it('field-level attribution is used when the record actually carries it', () => {
        expect(fieldSource(rec('c1', { a: 1 }, 'pubchem'), 'a')).toBe('pubchem');
        expect(fieldSource(unattributed('c1', { a: 1 }, 'pubchem'), 'a')).toBeNull();
    });

    it('ambiguous multi-source field ownership yields null, not a pick', () => {
        const r = { id: 'c1', a: 1, provenance: { primary_source: 'pubchem', sources: [
            { source: 'pubchem', fields: ['a'] }, { source: 'chembl', fields: ['a'] }] } };
        expect(fieldSource(r, 'a')).toBeNull();
    });
});

describe('CORRECTION 4 -- overflow fails closed, never truncates', () => {
    it('throws rather than discarding evidence past the cap', () => {
        let cur = rec('c1', { a: 0 }, 's0');
        let thrown = null;
        for (let i = 1; i <= MAX_COMPETING_CLAIMS_PER_RECORD + 5; i++) {
            try {
                cur = mergePreservingConflicts(cur, rec('c1', { a: i }, `s${i}`), `s${i}`).merged;
            } catch (e) { thrown = e; break; }
        }
        expect(thrown).toBeInstanceOf(MergeClaimOverflowError);
        expect(thrown.cap).toBe(MAX_COMPETING_CLAIMS_PER_RECORD);
        expect(thrown.attempted).toBeGreaterThan(MAX_COMPETING_CLAIMS_PER_RECORD);
        // Nothing was silently trimmed on the way to the failure.
        expect(cur.competing_claims.length).toBeLessThanOrEqual(MAX_COMPETING_CLAIMS_PER_RECORD);
    });
});

describe('CORRECTION 5 -- the served value is never also a displaced claim', () => {
    it('a value cycling back to winner is removed from the claim list', () => {
        let cur = rec('c1', { a: 1 }, 'pubchem');
        cur = mergePreservingConflicts(cur, rec('c1', { a: 2 }, 'chembl'), 'chembl').merged;
        expect(cur.competing_claims.map(c => c.value)).toEqual([1]);
        cur = mergePreservingConflicts(cur, rec('c1', { a: 1 }, 'dailymed'), 'dailymed').merged;
        expect(cur.a).toBe(1);
        // 1 is now served, so it must not also be listed as displaced.
        expect(cur.competing_claims.map(c => c.value)).toEqual([2]);
        expect(cur.competing_claims.some(c => valuesAgree(c.value, cur.a))).toBe(false);
    });

    it('the claim list disappears entirely when nothing is displaced any more', () => {
        let cur = rec('c1', { a: 1 }, 'pubchem');
        cur = mergePreservingConflicts(cur, rec('c1', { a: 2 }, 'chembl'), 'chembl').merged;
        cur = mergePreservingConflicts(cur, rec('c1', { a: 1 }, 'x').constructor === Object
            ? rec('c1', { a: 1 }, 'x') : rec('c1', { a: 1 }, 'x'), 'x').merged;
        expect(cur.competing_claims.map(c => c.value)).toEqual([2]);
    });
});

describe('what is NOT a conflict, and behaviour preserved', () => {
    it('filling a previously absent field', () => {
        expect(mergePreservingConflicts(rec('c1', {}, 'pubchem'),
            rec('c1', { logp: 1.2 }, 'chembl'), 'chembl').conflicts).toHaveLength(0);
    });

    it('identical values, including nested objects in a different key order', () => {
        const a = rec('c1', { x: { p: 1, q: [1, 2] } }, 'pubchem');
        const b = rec('c1', { x: { q: [1, 2], p: 1 } }, 'chembl');
        expect(valuesAgree(a.x, b.x)).toBe(true);
        expect(mergePreservingConflicts(a, b, 'chembl').conflicts).toHaveLength(0);
    });

    it('array order IS significant and does conflict', () => {
        expect(mergePreservingConflicts(rec('c1', { syn: ['a', 'b'] }, 'pubchem'),
            rec('c1', { syn: ['b', 'a'] }, 'chembl'), 'chembl').conflicts).toHaveLength(1);
    });

    it('structural keys are never claims', () => {
        expect(detectFieldConflicts({ id: 'c1' }, { id: 'c2' }).conflicts).toHaveLength(0);
    });

    it('union-merges provenance sources without duplicating', () => {
        const { merged } = mergePreservingConflicts(rec('c1', { a: 1 }, 'pubchem'),
            rec('c1', { a: 1 }, 'chembl'), 'chembl');
        expect(merged.provenance.sources.map(s => s.source)).toEqual(['pubchem', 'chembl']);
    });

    it('does not mutate the inputs', () => {
        const existing = rec('c1', { a: 1 }, 'pubchem');
        const before = JSON.stringify(existing);
        mergePreservingConflicts(existing, rec('c1', { a: 2 }, 'chembl'), 'chembl');
        expect(JSON.stringify(existing)).toBe(before);
    });
});
