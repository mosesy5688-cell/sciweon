/**
 * Lane 4 -- assessor tests.
 *
 * Covers brief tests 3 (per-pair resolution over the full cross-product),
 * 4 (the two labels rejected on sight), 5 (equal in effect, in the L4-3
 * projection), 6 (fails closed, always returned and never thrown), 9 (the
 * output-key contract) and the L4-2 closed-vocabulary test.
 *
 * Evidence level: these tests establish that the module returns the values it
 * declares. They establish nothing about enforcement. Nothing in this lane
 * enforces anything, and these are logical-partition tests: they do not prove
 * that a packaged artifact rejects a cross-plane field.
 */

import { describe, it, expect } from 'vitest';
import { verdict, assess } from '../../scripts/factory/lib/rights-candidate-assessor.js';
import { snapshot } from '../../scripts/factory/lib/rights-candidate-registry-data.js';

const PAIRS = snapshot();
const FIELDS = PAIRS.map((r) => r.field);
const PLANE_SOURCES = ['pubchem', 'chembl', 'pubmed'];
const NO_PLANE_SOURCES = ['uniprot', 'unichem', 'meddra', 'kegg'];
const UNKNOWN_SOURCES = ['openalex', 'rxnorm', 'clinicaltrials', ''];

/** The frozen three, per result type, transcribed from brief 3a and 3b. */
const FIELD_VERDICT_STATES = [
    'UNRESOLVED', 'NOT_IN_ANY_APPROVED_OUTPUT_PLANE', 'ADJUDICATED_AS_ASSERTED',
];
const UNIT_STATES = [
    'UNRESOLVED', 'NOT_IN_ANY_APPROVED_OUTPUT_PLANE',
    'ADJUDICATED_OBLIGATIONS_UNDISCHARGED',
];
const FIELD_VERDICT_KEYS = [
    'field', 'plane', 'rights_state', 'source', 'source_assertion',
    'source_independently_verified', 'state',
];
const UNIT_MANDATORY_KEYS = [
    'module_limits', 'source_assertion', 'source_independently_verified',
    'state', 'verdict',
];
const UNIT_ALL_KEYS = [...UNIT_MANDATORY_KEYS, 'findings', 'obligations'].sort();

type Unit = { source: string; field: string };

const CROSS: Unit[] = [];
for (const source of [...PLANE_SOURCES, ...NO_PLANE_SOURCES, ...UNKNOWN_SOURCES]) {
    for (const field of FIELDS) CROSS.push({ source, field });
}

const ADVERSARIAL: Unit[] = [
    { source: 'pubchem', field: 'smiles_canonical' },
    { source: 'pubchem', field: 'connectivity_smiles_renamed' },
    { source: 'chembl', field: 'pmid' },
    { source: 'pubmed', field: 'chembl_id' },
    { source: 'unichem', field: 'chembl_id' },
    { source: '', field: '' },
    { source: 'pubchem', field: '' },
    { source: '', field: 'inchi_key' },
];

const CORPUS: Unit[] = [...CROSS, ...ADVERSARIAL];

function expectedFieldState(unit: Unit): string {
    if (NO_PLANE_SOURCES.includes(unit.source)) return 'NOT_IN_ANY_APPROVED_OUTPUT_PLANE';
    const row = PAIRS.find((r) => r.source === unit.source && r.field === unit.field);
    return row === undefined ? 'UNRESOLVED' : 'ADJUDICATED_AS_ASSERTED';
}

/** L4-3 projection: drop top-level state and nested verdict state/source/field. */
function projected(result: Record<string, unknown>): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    delete copy.state;
    const inner = copy.verdict as Record<string, unknown> | undefined;
    if (inner !== undefined) {
        delete inner.state;
        delete inner.source;
        delete inner.field;
    }
    return copy;
}

describe('test 3 -- per-pair resolution over the full cross-product', () => {
    it('resolves every source x field cell exactly as the resolution order states', () => {
        expect(CROSS).toHaveLength(11 * 25);
        for (const unit of CROSS) {
            const v = verdict(unit);
            const expected = expectedFieldState(unit);
            expect(v.state, `${unit.source}/${unit.field}`).toBe(expected);
            if (expected === 'ADJUDICATED_AS_ASSERTED') {
                const row = PAIRS.find((r) => r.source === unit.source && r.field === unit.field);
                expect(v.plane).toBe(row?.plane);
                expect(v.rights_state).toBe(row?.rights_state);
            } else {
                expect(v.plane).toBeNull();
                expect(v.rights_state).toBeNull();
            }
        }
    });

    it('a field alone never resolves -- the wrong source loses the plane', () => {
        for (const row of PAIRS) {
            for (const source of PLANE_SOURCES) {
                if (source === row.source) continue;
                expect(verdict({ source, field: row.field }).plane).toBeNull();
            }
        }
    });
});

describe('test 4 -- the two labels rejected on sight', () => {
    it('(unichem, chembl_id) is not in any approved output plane', () => {
        const v = verdict({ source: 'unichem', field: 'chembl_id' });
        expect(v.state).toBe('NOT_IN_ANY_APPROVED_OUTPUT_PLANE');
        expect(v.plane).toBeNull();
        expect(v.rights_state).toBeNull();
    });

    it('uniprot carries no plane rights state, for any field at all', () => {
        for (const field of [...FIELDS, 'accession', 'sequence', '']) {
            const v = verdict({ source: 'uniprot', field });
            expect(v.state, field).toBe('NOT_IN_ANY_APPROVED_OUTPUT_PLANE');
            expect(v.rights_state, field).toBeNull();
        }
    });
});

describe('test 5 -- equal in effect, under the L4-3 projection', () => {
    it('a frozen-four pair and an unknown-source pair are equal under the projection', () => {
        for (const frozenSource of NO_PLANE_SOURCES) {
            for (const unknownSource of UNKNOWN_SOURCES) {
                const a = assess({ source: frozenSource, field: 'pubchem_cid' });
                const b = assess({ source: unknownSource, field: 'not_a_field' });
                expect(projected(a as Record<string, unknown>))
                    .toEqual(projected(b as Record<string, unknown>));
            }
        }
    });

    it('the projection still discriminates -- an adjudicated pair is not equal', () => {
        const closed = assess({ source: 'uniprot', field: 'pubchem_cid' });
        const open = assess({ source: 'pubchem', field: 'pubchem_cid' });
        expect(projected(closed as Record<string, unknown>))
            .not.toEqual(projected(open as Record<string, unknown>));
    });
});

describe('test 6 -- fails closed, returned and never thrown', () => {
    const circular: Record<string, unknown> = { source: 'not_a_source', field: 'not_a_field' };
    circular.self = circular;
    const thrower = {
        get source(): string { throw new Error('throwing getter'); },
        get field(): string { throw new Error('throwing getter'); },
    };
    const hostile: unknown[] = [
        undefined, null, 0, 1, '', 'pubchem', true, [], Symbol('s'), () => 'x',
        {}, { source: 'nope' }, { field: 'inchi_key' },
        { source: null, field: null }, { source: 'pubchem', field: null },
        { source: 42, field: 42 }, circular, thrower, Object.create(null),
    ];

    it('returns UNRESOLVED for every hostile input and throws for none', () => {
        for (const input of hostile) {
            const label = String(typeof input);
            expect(() => verdict(input as never), label).not.toThrow();
            expect(() => assess(input as never), label).not.toThrow();
            expect(verdict(input as never).state, label).toBe('UNRESOLVED');
            expect(assess(input as never).state, label).toBe('UNRESOLVED');
        }
    });

    it('a hostile manifest is also returned, never thrown', () => {
        const circularManifest: Record<string, unknown> = { plane: 'CLEAN_COMMERCIAL' };
        circularManifest.self = circularManifest;
        const throwingManifest = { get plane(): string { throw new Error('boom'); } };
        const unit = { source: 'pubchem', field: 'inchi_key' };
        for (const manifest of [circularManifest, throwingManifest, 0, '', null, []]) {
            expect(() => assess(unit, manifest as never)).not.toThrow();
        }
    });
});

describe('test 9 and L4-2 -- the output-key contract and the closed vocabulary', () => {
    it('FieldVerdict emits exactly the seven keys, in every state', () => {
        const seen = new Set<string>();
        for (const unit of CORPUS) {
            const v = verdict(unit);
            expect(Object.keys(v).sort()).toEqual(FIELD_VERDICT_KEYS);
            expect(v.source_assertion).toBe('caller_supplied');
            expect(v.source_independently_verified).toBe(false);
            seen.add(v.state);
        }
        expect([...seen].sort()).toEqual([...FIELD_VERDICT_STATES].sort());
    });

    it('UnitAssessment keys are a subset of seven and a superset of five', () => {
        for (const unit of CORPUS) {
            const keys = Object.keys(assess(unit)).sort();
            for (const key of keys) expect(UNIT_ALL_KEYS, key).toContain(key);
            for (const key of UNIT_MANDATORY_KEYS) expect(keys, key).toContain(key);
            expect(keys).not.toContain('publishable');
        }
    });

    it('obligations and findings are never emitted as an empty array', () => {
        const manifests = [undefined, {}, { plane: 'BIBLIOGRAPHIC' }, { field: 'x' }];
        for (const unit of CORPUS) {
            for (const manifest of manifests) {
                const r = assess(unit, manifest as never) as Record<string, unknown>;
                for (const key of ['obligations', 'findings']) {
                    if (Object.prototype.hasOwnProperty.call(r, key)) {
                        expect(Array.isArray(r[key]), key).toBe(true);
                        expect((r[key] as unknown[]).length, key).toBeGreaterThan(0);
                    }
                }
            }
        }
    });

    it('the distinct emitted state values deep-equal the frozen three, per type', () => {
        const fieldStates = new Set<string>();
        const unitStates = new Set<string>();
        for (const unit of CORPUS) {
            fieldStates.add(verdict(unit).state);
            unitStates.add(assess(unit).state);
        }
        expect([...fieldStates].sort()).toEqual([...FIELD_VERDICT_STATES].sort());
        expect([...unitStates].sort()).toEqual([...UNIT_STATES].sort());
    });

    it('an adjudicated pair always carries a non-empty obligations array', () => {
        for (const row of PAIRS) {
            const r = assess({ source: row.source, field: row.field }) as Record<string, unknown>;
            expect(r.state).toBe('ADJUDICATED_OBLIGATIONS_UNDISCHARGED');
            expect((r.obligations as unknown[]).length).toBeGreaterThan(0);
        }
    });
});
