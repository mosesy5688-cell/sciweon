/**
 * Lane 4 -- manifest-consistency tests.
 *
 * Covers brief test 1 (the universal no-self-certification invariant, run
 * over UnitAssessment and not only over FieldVerdict) and L4-4, which
 * requires BOTH directions: a disagreeing manifest must produce a real
 * finding, and an agreeing manifest must produce a result exactly equal to
 * the no-manifest result. Together those kill the no-op stub and its mirror,
 * the module that emits a fixed finding whenever a manifest is present.
 *
 * There is no success signal anywhere here. Agreement is silence.
 */

import { describe, it, expect } from 'vitest';
import { verdict, assess } from '../../scripts/factory/lib/rights-candidate-assessor.js';
import {
    manifestFindings,
    manifestAspects,
    MANIFEST_DISAGREEMENT_CODE,
} from '../../scripts/factory/lib/rights-manifest-consistency.js';
import { snapshot } from '../../scripts/factory/lib/rights-candidate-registry-data.js';

const PAIRS = snapshot();

type Unit = { source: string; field: string };

const ADVERSARIAL: Unit[] = [
    { source: 'uniprot', field: 'pubchem_cid' },
    { source: 'unichem', field: 'chembl_id' },
    { source: 'meddra', field: 'pt_code' },
    { source: 'kegg', field: 'kegg_id' },
    { source: 'pubchem', field: 'smiles_canonical' },
    { source: 'openalex', field: 'doi' },
    { source: '', field: '' },
    { source: 'pubmed', field: 'chembl_id' },
];

const CORPUS: Unit[] = [
    ...PAIRS.map((r) => ({ source: r.source, field: r.field })),
    ...ADVERSARIAL,
];

const FINDING_KEYS = [
    'aspect', 'code', 'discharged_by_this_module', 'enforced',
    'manifest_value', 'registry_value',
];

/** Every manifest tried against one unit, agreeing and fabricated alike. */
function manifestsFor(unit: Unit): unknown[] {
    const v = verdict(unit);
    return [
        undefined,
        null,
        {},
        { source: v.source, field: v.field, plane: v.plane, rights_state: v.rights_state },
        { plane: v.plane },
        { rights_state: v.rights_state },
        { plane: 'CLEAN_COMMERCIAL' },
        { plane: 'LICENSED_SHAREALIKE', rights_state: 'LICENSED_SHAREALIKE' },
        { plane: 'BIBLIOGRAPHIC', rights_state: 'NO_LICENCE_GRANTED_ATTRIBUTION_REQUIRED' },
        { source: 'pubchem', field: 'inchi_key', plane: 'CLEAN_COMMERCIAL',
            rights_state: 'CLEAN_COMMERCIAL_FIELD_QUALIFIED' },
        { source: 'unichem', field: 'chembl_id', plane: 'LICENSED_SHAREALIKE',
            rights_state: 'LICENSED_SHAREALIKE' },
        { unrelated_key: 'ignored' },
        0, 1, '', 'manifest', true, [],
    ];
}

function withoutFindings(result: unknown): Record<string, unknown> {
    const copy = { ...(result as Record<string, unknown>) };
    delete copy.findings;
    return copy;
}

describe('test 1 -- the universal invariant, over UnitAssessment', () => {
    it('assess(u, m) equals assess(u) after removing findings, for every manifest', () => {
        let pairsChecked = 0;
        expect(CORPUS).toHaveLength(33);
        expect(manifestsFor(CORPUS[0])).toHaveLength(18);
        for (const unit of CORPUS) {
            const base = assess(unit) as Record<string, unknown>;
            expect(Object.prototype.hasOwnProperty.call(base, 'findings')).toBe(false);
            for (const manifest of manifestsFor(unit)) {
                const withManifest = assess(unit, manifest as never);
                expect(
                    withoutFindings(withManifest),
                    `${unit.source}/${unit.field} :: ${JSON.stringify(manifest)}`,
                ).toEqual(base);
                pairsChecked += 1;
            }
        }
        expect(pairsChecked).toBe(CORPUS.length * 18);
    });

    it('a manifest never changes the verdict, the state or the obligations', () => {
        for (const unit of CORPUS) {
            const base = assess(unit) as Record<string, unknown>;
            for (const manifest of manifestsFor(unit)) {
                const r = assess(unit, manifest as never) as Record<string, unknown>;
                expect(r.state).toEqual(base.state);
                expect(r.verdict).toEqual(base.verdict);
                expect(r.module_limits).toEqual(base.module_limits);
                expect(r.obligations).toEqual(base.obligations);
            }
        }
    });

    it('the verdict is computed with no manifest reachable from its call path', () => {
        expect(verdict.length).toBe(1);
        expect(assess.length).toBe(2);
        for (const unit of CORPUS) {
            const bare = verdict(unit);
            for (const manifest of manifestsFor(unit)) {
                expect((assess(unit, manifest as never) as { verdict: unknown }).verdict)
                    .toEqual(bare);
            }
        }
    });
});

describe('L4-4 case 1 -- a disagreeing manifest emits a real finding', () => {
    it('produces a non-empty Finding[] of the declared shape, per aspect', () => {
        const unit = { source: 'pubchem', field: 'inchi_key' };
        const disagreements: Array<[string, Record<string, unknown>, unknown, unknown]> = [
            ['plane', { plane: 'BIBLIOGRAPHIC' }, 'BIBLIOGRAPHIC', 'CLEAN_COMMERCIAL'],
            ['rights_state', { rights_state: 'LICENSED_SHAREALIKE' },
                'LICENSED_SHAREALIKE', 'CLEAN_COMMERCIAL_FIELD_QUALIFIED'],
            ['source', { source: 'unichem' }, 'unichem', 'pubchem'],
            ['field', { field: 'iupac_name' }, 'iupac_name', 'inchi_key'],
        ];
        for (const [aspect, manifest, manifestValue, registryValue] of disagreements) {
            const r = assess(unit, manifest as never) as Record<string, unknown>;
            const findings = r.findings as Array<Record<string, unknown>>;
            expect(Array.isArray(findings), aspect).toBe(true);
            expect(findings.length, aspect).toBeGreaterThan(0);
            expect(Object.keys(findings[0]).sort()).toEqual(FINDING_KEYS);
            expect(findings[0].code).toBe(MANIFEST_DISAGREEMENT_CODE);
            expect(findings[0].aspect).toBe(aspect);
            expect(findings[0].manifest_value).toBe(manifestValue);
            expect(findings[0].registry_value).toBe(registryValue);
            expect(findings[0].enforced).toBe(false);
            expect(findings[0].discharged_by_this_module).toBe(false);
        }
    });

    it('assess(u) with no manifest carries no findings key at all', () => {
        const unit = { source: 'pubchem', field: 'inchi_key' };
        expect(Object.prototype.hasOwnProperty.call(assess(unit), 'findings')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(assess(unit, undefined), 'findings')).toBe(false);
    });

    it('emits one finding per disagreeing aspect, across the whole corpus', () => {
        let disagreementsSeen = 0;
        for (const unit of CORPUS) {
            const v = verdict(unit);
            const wrong = {
                source: `${v.source}_wrong`,
                field: `${v.field}_wrong`,
                plane: 'NOT_A_REAL_PLANE',
                rights_state: 'NOT_A_REAL_RIGHTS_STATE',
            };
            const findings = (assess(unit, wrong) as { findings: unknown[] }).findings;
            expect(findings).toHaveLength(4);
            disagreementsSeen += findings.length;
        }
        expect(disagreementsSeen).toBe(CORPUS.length * 4);
    });
});

describe('L4-4 case 2 -- an agreeing manifest changes nothing at all', () => {
    it('assess(u, agreeing) deep-equals assess(u) exactly, with no findings key', () => {
        for (const unit of CORPUS) {
            const v = verdict(unit);
            const agreeing = {
                source: v.source, field: v.field,
                plane: v.plane, rights_state: v.rights_state,
            };
            const withManifest = assess(unit, agreeing) as Record<string, unknown>;
            expect(Object.prototype.hasOwnProperty.call(withManifest, 'findings')).toBe(false);
            expect(withManifest).toEqual(assess(unit));
        }
    });

    it('a partially agreeing manifest is silent on the aspects it agrees about', () => {
        const unit = { source: 'chembl', field: 'pchembl_value' };
        const r = assess(unit, {
            plane: 'LICENSED_SHAREALIKE',
            rights_state: 'WRONG_RIGHTS_STATE',
        }) as { findings: Array<{ aspect: string }> };
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].aspect).toBe('rights_state');
    });
});

describe('the manifest module itself', () => {
    it('inspects exactly the four declared aspects', () => {
        expect(manifestAspects()).toEqual(['source', 'field', 'plane', 'rights_state']);
    });

    it('returns undefined rather than an empty array when nothing disagrees', () => {
        const v = verdict({ source: 'pubmed', field: 'pmid' });
        expect(manifestFindings(v, undefined)).toBeUndefined();
        expect(manifestFindings(v, null)).toBeUndefined();
        expect(manifestFindings(v, {})).toBeUndefined();
        expect(manifestFindings(v, { plane: 'BIBLIOGRAPHIC' })).toBeUndefined();
        expect(manifestFindings(v, 'not an object' as never)).toBeUndefined();
    });

    it('never throws for a hostile manifest', () => {
        const v = verdict({ source: 'pubmed', field: 'pmid' });
        const circular: Record<string, unknown> = { plane: 'X' };
        circular.self = circular;
        const throwing = { get plane(): string { throw new Error('boom'); } };
        for (const manifest of [circular, throwing, [], 0, Symbol('s'), () => 1]) {
            expect(() => manifestFindings(v, manifest as never)).not.toThrow();
        }
    });
});
