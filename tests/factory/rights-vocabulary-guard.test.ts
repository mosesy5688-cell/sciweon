/**
 * Lane 4 -- the vocabulary guard (brief test 8), the forbidden permission
 * words (test 10) and the wired-to-nothing pinning test (test 14).
 *
 * THIS FILE IS THE SINGLE GUARDED_FILES EXEMPTION. It must contain the
 * pattern literal in order to work, so it is the one rights-* file the guard
 * does not read. There is no other exemption. If the guard fires on a comment
 * anywhere else, reword the comment; never weaken the guard.
 *
 * L4-5 / L4-6: the eight pre-approved paths are a FROZEN LITERAL here, not a
 * glob, and there are TWO comparisons. The on-disk listing must deep-equal
 * all eight; GUARDED_FILES must deep-equal the eight minus this file. An
 * omission fails the second; a rename or directory move fails the first.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as registryData from '../../scripts/factory/lib/rights-candidate-registry-data.js';
import * as assessor from '../../scripts/factory/lib/rights-candidate-assessor.js';
import * as manifestConsistency from '../../scripts/factory/lib/rights-manifest-consistency.js';

const GUARD_PATTERN = /physical|isolat|withheld/i;

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const LITERAL_8 = [
    'scripts/factory/lib/rights-candidate-registry-data.js',
    'scripts/factory/lib/rights-candidate-assessor.js',
    'scripts/factory/lib/rights-manifest-consistency.js',
    'tests/factory/rights-candidate-registry-data.test.ts',
    'tests/factory/rights-candidate-assessor.test.ts',
    'tests/factory/rights-manifest-consistency.test.ts',
    'tests/factory/rights-immutability.test.ts',
    'tests/factory/rights-vocabulary-guard.test.ts',
];
const SINGLE_EXEMPTION = 'tests/factory/rights-vocabulary-guard.test.ts';
const LANE_MODULES = ['rights-candidate-registry-data',
    'rights-candidate-assessor', 'rights-manifest-consistency'];

/**
 * Test 10. RELEASE_CANDIDATE is checked as a SUBSTRING, per 3c, which forbids
 * it as a state value, an identifier, an enum member, a comment and a test
 * title. The five siblings are checked as EXACT string equality, because 3c
 * forbids them "as state values" while the brief itself mandates the emitted
 * value NOT_IN_ANY_APPROVED_OUTPUT_PLANE, which contains "APPROVED". A
 * substring rule over emitted values would make the frozen contract
 * unsatisfiable. Exported names are checked as substrings for all six.
 */
const FORBIDDEN_AS_VALUE = ['RELEASE_CANDIDATE', 'CLEARED',
    'CLEARED_FOR_RELEASE', 'APPROVED', 'PUBLISHABLE', 'READY'];
const ORDERING_NAMES = /rank|order|compar|preceden|severity|tier|grade|score|greater|maximal|level/i;
const STATE_VALUES = new Set(['UNRESOLVED', 'ADJUDICATED_AS_ASSERTED',
    'NOT_IN_ANY_APPROVED_OUTPUT_PLANE', 'ADJUDICATED_OBLIGATIONS_UNDISCHARGED']);

const MODULES: Array<[string, Record<string, unknown>]> = [
    ['registry-data', registryData as unknown as Record<string, unknown>],
    ['assessor', assessor as unknown as Record<string, unknown>],
    ['manifest-consistency', manifestConsistency as unknown as Record<string, unknown>],
];

const CORPUS = [
    ...registryData.snapshot().map((r) => ({ source: r.source, field: r.field })),
    ...[['uniprot', 'pubchem_cid'], ['unichem', 'chembl_id'], ['meddra', 'pt_code'],
        ['kegg', 'kegg_id'], ['nope', 'nope'], ['', '']].map(
        ([source, field]) => ({ source, field }),
    ),
];
const MANIFESTS: unknown[] = [undefined, {}, { plane: 'BIBLIOGRAPHIC' },
    { source: 'x', field: 'y', plane: 'z', rights_state: 'w' }];

const readRepoFile = (p: string): string => readFileSync(REPO_ROOT + p, 'utf8');

function trackedFiles(): string[] {
    return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
        .toString('utf8').split('\0').filter(Boolean);
}

function onDiskRightsListing(): string[] {
    const found: string[] = [];
    for (const directory of ['scripts/factory/lib', 'tests/factory']) {
        for (const entry of readdirSync(REPO_ROOT + directory, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.startsWith('rights-')) {
                found.push(`${directory}/${entry.name}`);
            }
        }
    }
    return found;
}

function walk(value: unknown, out: string[], seen: WeakSet<object>): string[] {
    if (typeof value === 'string') { out.push(value); return out; }
    if (value === null || typeof value !== 'object' || seen.has(value as object)) return out;
    seen.add(value as object);
    for (const key of Object.keys(value as Record<string, unknown>)) {
        out.push(key);
        walk((value as Record<string, unknown>)[key], out, seen);
    }
    return out;
}

const collect = (value: unknown): string[] => walk(value, [], new WeakSet());

/** Every string this lane can emit: keys and values, both result types. */
const EMITTED: string[] = (() => {
    const out: string[] = [];
    for (const unit of CORPUS) {
        out.push(...collect(assessor.verdict(unit)));
        for (const m of MANIFESTS) out.push(...collect(assessor.assess(unit, m as never)));
    }
    out.push(...collect(registryData.count()), ...collect(registryData.snapshot()));
    out.push(...collect(registryData.moduleLimits()), ...collect(registryData.planeIds()));
    for (const p of registryData.planeIds()) out.push(...collect(registryData.planeRecord(p)));
    return out;
})();

function titlesIn(source: string): string[] {
    const pattern = /\b(?:describe|it|test)\s*\(\s*(['"`])([\s\S]*?)\1/g;
    return [...source.matchAll(pattern)].map((m) => m[2]);
}

describe('test 8 -- GUARDED_FILES completeness, against TWO literals', () => {
    it('the on-disk rights-* listing deep-equals the frozen eight', () => {
        expect(onDiskRightsListing().sort()).toEqual([...LITERAL_8].sort());
    });

    it('GUARDED_FILES deep-equals the eight minus the single exemption', () => {
        const expected = LITERAL_8.filter((p) => p !== SINGLE_EXEMPTION);
        expect(expected).toHaveLength(7);
        expect([...registryData.GUARDED_FILES].sort()).toEqual([...expected].sort());
        expect(registryData.GUARDED_FILES).not.toContain(SINGLE_EXEMPTION);
    });

    it('every guarded file exists on disk and is non-empty', () => {
        for (const path of registryData.GUARDED_FILES) {
            expect(readRepoFile(path).length, path).toBeGreaterThan(0);
        }
    });
});

describe('test 8 -- the guard, all four layers', () => {
    it('layer 1: no emitted key or value matches the guarded stems', () => {
        expect(EMITTED.length).toBeGreaterThan(500);
        for (const value of EMITTED) expect(GUARD_PATTERN.test(value), value).toBe(false);
    });

    it('layer 2: no exported name matches the guarded stems', () => {
        for (const [label, namespace] of MODULES) {
            for (const name of Object.keys(namespace)) {
                expect(GUARD_PATTERN.test(name), `${label}:${name}`).toBe(false);
            }
        }
    });

    it('layer 3: no guarded source text matches the guarded stems', () => {
        for (const path of registryData.GUARDED_FILES) {
            expect(GUARD_PATTERN.test(readRepoFile(path)), path).toBe(false);
        }
    });

    it('layer 4: no test title in a guarded file matches the guarded stems', () => {
        let titlesChecked = 0;
        for (const path of registryData.GUARDED_FILES) {
            if (!path.endsWith('.test.ts')) continue;
            for (const title of titlesIn(readRepoFile(path))) {
                expect(GUARD_PATTERN.test(title), `${path}: ${title}`).toBe(false);
                titlesChecked += 1;
            }
        }
        expect(titlesChecked).toBeGreaterThan(20);
    });

    it('the guard fires on a known-positive control and not on a known-negative', () => {
        for (const control of ['physical', 'ISOLATION', 'isolated', 'Withheld']) {
            expect(GUARD_PATTERN.test(control), control).toBe(true);
        }
        for (const control of ['LOGICAL_PARTITION', 'separation_model', 'separate']) {
            expect(GUARD_PATTERN.test(control), control).toBe(false);
        }
    });
});

describe('test 10 -- the forbidden permission words', () => {
    it('no emitted key or value equals a forbidden permission word', () => {
        for (const value of EMITTED) {
            expect(FORBIDDEN_AS_VALUE, value).not.toContain(value);
            expect(value.includes('RELEASE' + '_CANDIDATE'), value).toBe(false);
        }
    });

    it('no exported name contains a forbidden permission word', () => {
        for (const [label, namespace] of MODULES) {
            for (const name of Object.keys(namespace)) {
                for (const banned of FORBIDDEN_AS_VALUE) {
                    expect(name.toUpperCase().includes(banned), `${label}:${name}`).toBe(false);
                }
            }
        }
    });

    it('RELEASE_CANDIDATE appears nowhere in any lane source file', () => {
        for (const path of LITERAL_8) {
            if (path === SINGLE_EXEMPTION) continue;
            expect(readRepoFile(path).includes('RELEASE' + '_CANDIDATE'), path).toBe(false);
        }
    });

    it('no ordering, rank or comparison over the states is exported', () => {
        for (const [label, namespace] of MODULES) {
            for (const [name, value] of Object.entries(namespace)) {
                expect(ORDERING_NAMES.test(name), `${label}:${name}`).toBe(false);
                const holdsState = Array.isArray(value)
                    && value.some((v) => typeof v === 'string' && STATE_VALUES.has(v));
                expect(holdsState, `${label}:${name}`).toBe(false);
            }
        }
    });
});

describe('test 14 -- wired to nothing, pinned rather than asserted in prose', () => {
    it('no file outside the lane rights-* paths references any lane module', () => {
        const tracked = trackedFiles();
        expect(tracked.length).toBeGreaterThan(700);
        const offenders: string[] = [];
        for (const path of tracked) {
            if (path.startsWith('scripts/factory/lib/rights-')) continue;
            if (path.startsWith('tests/factory/rights-')) continue;
            let contents = '';
            try { contents = readRepoFile(path); } catch { continue; }
            for (const moduleName of LANE_MODULES) {
                if (contents.includes(moduleName)) offenders.push(`${path} -> ${moduleName}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('module_limits keeps claiming no wiring, because there is none', () => {
        const limits = assessor.limits();
        expect(limits).toEqual(registryData.moduleLimits());
        expect(limits.wired_to_serving_path).toBe(false);
        expect(limits.wired_to_packaging_path).toBe(false);
        expect(limits.end_to_end).toBe(false);
        expect(limits.separation_proven_by_packaging_artifact).toBe(false);
        expect(limits.packaging_cross_plane_rejection_tests_present).toBe(false);
    });
});
