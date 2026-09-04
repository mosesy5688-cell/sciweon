/**
 * Lane 4 -- genuine immutability tests (brief test 7, section 6).
 *
 * The five traps this file exists to close:
 *   1. Object.isFrozen is NEVER the assertion. It returns true for a frozen
 *      Set whose contents are fully mutable. The assertion is always the
 *      RE-INVOKED accessor's content, compared against the canonical 25.
 *   2. Object.freeze is one level deep. Depth is walked explicitly.
 *   3. The live collection is never returned. Accessors return fresh copies.
 *   4. Mutate, then re-invoke, then compare.
 *   5. The attempts behave asymmetrically: a frozen array's push THROWS in
 *      module scope while a frozen Set's add returns SILENTLY. Every attempt
 *      is wrapped, and the throw is never the assertion.
 */

import { describe, it, expect } from 'vitest';
import {
    snapshot,
    planeRecord,
    allObligations,
    obligationsForPlane,
    moduleLimits,
    count,
    sourcesWithoutPlaneMembership,
    GUARDED_FILES,
} from '../../scripts/factory/lib/rights-candidate-registry-data.js';

/** The canonical 25, transcribed here so the comparison is not self-referential. */
const CANONICAL: Array<[string, string, string]> = [];
for (const field of [
    'pubchem_cid', 'inchi_key', 'molecular_formula', 'connectivity_smiles', 'iupac_name',
]) CANONICAL.push(['pubchem', field, 'CLEAN_COMMERCIAL']);
for (const field of [
    'chembl_db_version', 'chembl_release_date', 'chembl_target_id', 'chembl_id',
    'assay_chembl_id', 'assay_description', 'assay_organism', 'standard_type',
    'standard_relation', 'standard_value', 'standard_units', 'pchembl_value',
    'source_record_activity_id', 'document_chembl_id',
]) CANONICAL.push(['chembl', field, 'LICENSED_SHAREALIKE']);
for (const field of [
    'pmid', 'doi', 'journal', 'pubdate', 'volume', 'pages',
]) CANONICAL.push(['pubmed', field, 'BIBLIOGRAPHIC']);

function asTriples(rows: ReadonlyArray<Record<string, unknown>>): Array<[string, string, string]> {
    return rows.map((r) => [r.source as string, r.field as string, r.plane as string]);
}

/** Attempts every mutation shape, swallowing every outcome. Never asserts here. */
function attackCollection(target: unknown): void {
    const anyTarget = target as Record<string, unknown> & {
        add?: (v: unknown) => unknown;
        delete?: (v: unknown) => unknown;
        clear?: () => unknown;
        push?: (v: unknown) => unknown;
        pop?: () => unknown;
        set?: (k: unknown, v: unknown) => unknown;
        length?: number;
    };
    const attempts: Array<() => unknown> = [
        () => anyTarget.add?.('INJECTED'),
        () => anyTarget.delete?.('INJECTED'),
        () => anyTarget.clear?.(),
        () => anyTarget.push?.({ source: 'injected', field: 'injected', plane: 'INJECTED' }),
        () => anyTarget.pop?.(),
        () => anyTarget.set?.('injected', 'INJECTED'),
        () => { anyTarget[0] = 'INJECTED'; },
        () => { anyTarget.injected = 'INJECTED'; },
        () => { anyTarget.length = 0; },
        () => Reflect.deleteProperty(anyTarget, '0'),
        () => delete anyTarget[1],
        () => Object.defineProperty(anyTarget, 'injected', { value: 1 }),
    ];
    for (const attempt of attempts) {
        try { attempt(); } catch { /* an attempt may throw or be silent; neither is the assertion */ }
    }
}

function everyNestedValueIsFrozen(value: unknown, seen: WeakSet<object>): boolean {
    if (value === null || typeof value !== 'object') return true;
    if (seen.has(value as object)) return true;
    seen.add(value as object);
    if (!Object.isFrozen(value)) return false;
    for (const key of Object.getOwnPropertyNames(value)) {
        if (!everyNestedValueIsFrozen((value as Record<string, unknown>)[key], seen)) return false;
    }
    return true;
}

describe('trap 5 -- the asymmetry, demonstrated before it is relied on', () => {
    it("a frozen Set's add is silent, so Object.isFrozen is not an admissible assertion", () => {
        const frozenSet = Object.freeze(new Set(['a']));
        expect(Object.isFrozen(frozenSet)).toBe(true);
        let threw = false;
        try { frozenSet.add('b'); } catch { threw = true; }
        expect(threw).toBe(false);
        expect(frozenSet.size).toBe(2);
    });

    it("a frozen array's push throws TypeError in module scope", () => {
        const frozenArray = Object.freeze(['a']);
        let threw = false;
        try { (frozenArray as string[]).push('b'); } catch (error) {
            threw = error instanceof TypeError;
        }
        expect(threw).toBe(true);
        expect(frozenArray).toHaveLength(1);
    });

    it('no accessor ever hands back a Set or a Map', () => {
        const returned: unknown[] = [
            snapshot(), allObligations(), obligationsForPlane('CLEAN_COMMERCIAL'),
            moduleLimits(), count(), count().obligations, planeRecord('BIBLIOGRAPHIC'),
            sourcesWithoutPlaneMembership(), GUARDED_FILES,
        ];
        for (const value of returned) {
            expect(value instanceof Set).toBe(false);
            expect(value instanceof Map).toBe(false);
        }
    });
});

describe('trap 4 -- mutate, re-invoke, compare against the canonical 25', () => {
    it('the registry snapshot survives every mutation attempt', () => {
        expect(asTriples(snapshot() as ReadonlyArray<Record<string, unknown>>)).toEqual(CANONICAL);
        const live = snapshot();
        attackCollection(live);
        for (const row of live) attackCollection(row);
        expect(asTriples(snapshot() as ReadonlyArray<Record<string, unknown>>)).toEqual(CANONICAL);
        expect(snapshot()).toHaveLength(25);
    });

    it('the obligations survive every mutation attempt, at depth', () => {
        const before = allObligations().map((o) => o.id);
        const live = allObligations();
        attackCollection(live);
        for (const obligation of live) attackCollection(obligation);
        expect(allObligations().map((o) => o.id)).toEqual(before);
        for (const obligation of allObligations()) {
            expect(obligation.enforced).toBe(false);
            expect(obligation.discharged_by_this_module).toBe(false);
        }
    });

    it('module_limits survives every mutation attempt', () => {
        const before = moduleLimits();
        attackCollection(moduleLimits());
        const live = moduleLimits() as Record<string, unknown>;
        try { live.end_to_end = true; } catch { /* silent or throwing; neither is the assertion */ }
        try { live.separation_model = 'INJECTED'; } catch { /* same */ }
        expect(moduleLimits()).toEqual(before);
        expect(moduleLimits().end_to_end).toBe(false);
        expect(moduleLimits().separation_model).toBe('LOGICAL_PARTITION');
    });

    it('plane records and per-plane obligations survive at depth', () => {
        const before = planeRecord('LICENSED_SHAREALIKE');
        const live = planeRecord('LICENSED_SHAREALIKE') as Record<string, unknown>;
        attackCollection(live);
        attackCollection(live.fields);
        attackCollection(live.attribution);
        expect(planeRecord('LICENSED_SHAREALIKE')).toEqual(before);
        const obligationsBefore = obligationsForPlane('BIBLIOGRAPHIC');
        const obligationsLive = obligationsForPlane('BIBLIOGRAPHIC');
        attackCollection(obligationsLive);
        for (const obligation of obligationsLive) attackCollection(obligation);
        expect(obligationsForPlane('BIBLIOGRAPHIC')).toEqual(obligationsBefore);
    });

    it('the second frozen list and GUARDED_FILES survive every attempt', () => {
        const sourcesBefore = sourcesWithoutPlaneMembership();
        attackCollection(sourcesWithoutPlaneMembership());
        expect(sourcesWithoutPlaneMembership()).toEqual(sourcesBefore);
        const guardedBefore = [...GUARDED_FILES];
        attackCollection(GUARDED_FILES);
        expect([...GUARDED_FILES]).toEqual(guardedBefore);
        expect(GUARDED_FILES).toHaveLength(7);
    });

    it('the aggregate guard survives, and still carries its obligations', () => {
        const before = count();
        const live = count() as Record<string, unknown>;
        attackCollection(live);
        attackCollection(live.obligations);
        attackCollection(live.by_plane);
        expect(count()).toEqual(before);
        expect(count().total).toBe(25);
        expect(count().obligations).toHaveLength(8);
    });
});

describe('trap 3 -- the live collection is never returned', () => {
    it('each call returns a fresh object graph, not the module-held one', () => {
        expect(snapshot()).not.toBe(snapshot());
        expect(snapshot()[0]).not.toBe(snapshot()[0]);
        expect(allObligations()).not.toBe(allObligations());
        expect(allObligations()[0]).not.toBe(allObligations()[0]);
        expect(moduleLimits()).not.toBe(moduleLimits());
        expect(planeRecord('CLEAN_COMMERCIAL')).not.toBe(planeRecord('CLEAN_COMMERCIAL'));
        expect(count()).not.toBe(count());
    });
});

describe('trap 2 -- the freeze reaches every level, not just the first', () => {
    it('every nested value of every returned collection is frozen', () => {
        const returned: unknown[] = [
            snapshot(), allObligations(), obligationsForPlane('LICENSED_SHAREALIKE'),
            moduleLimits(), count(), planeRecord('CLEAN_COMMERCIAL'),
            planeRecord('BIBLIOGRAPHIC'), sourcesWithoutPlaneMembership(), GUARDED_FILES,
        ];
        for (const value of returned) {
            expect(everyNestedValueIsFrozen(value, new WeakSet())).toBe(true);
        }
    });
});
