/**
 * Lane 3S -- bypass guards for the shared containment boundary.
 *
 * WHAT THESE GUARDS ARE (C-2.2): KNOWN-CHANNEL REGRESSION TRIPWIRES. They
 * detect regression on channels that have already been enumerated -- an added
 * parameter, an `arguments` read, a serving import of the test-only entry
 * point, a thirteenth function, a global used as a value rather than a callee.
 *
 * WHAT THEY ARE NOT: a formal completeness proof. No source-text guard shows
 * that no external state can influence containment, and extending a
 * forbidden-name list would not make one. The absolute claim is WITHDRAWN
 * (C-2.1). The behavioural probes below are DEFENCE IN DEPTH only: a
 * strict-equality gate such as `mode === 'raw'` survives every one of them.
 * The source-level signature pins are what close the argument channel.
 *
 * MEASUREMENT INVARIANT: every matcher used as evidence below is first shown
 * to DETECT a known positive and to return nothing on a known negative, with
 * DIFFERENT expected values on the two sides.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applySourceRightsFilter } from '../../src/worker/lib/source-rights-filter';
import { claimContainmentLegacyMechanisms } from '../../src/worker/lib/claim-containment-legacy-test-only';
import { attackFixture, FROZEN_CONTAINER_KEYS, CLAIM_MARKER_KEY } from './claim-containment-fixture';

const FILTER_PATH = 'src/worker/lib/source-rights-filter.ts';
const LEGACY_PATH = 'src/worker/lib/claim-containment-legacy-test-only.ts';
const SRC = readFileSync(FILTER_PATH, 'utf8');

/** Reduce a TS source to RUNTIME EXPRESSIONS: no comments, no string bodies. */
function runtimeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Body text of a module-scope function, up to its column-0 closing brace. */
function bodyOf(name: string): string {
    const lines = SRC.split('\n');
    const start = lines.findIndex(l => new RegExp('^(export )?function ' + name + '\\b').test(l));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
}

describe('the matchers themselves -- positive and negative controls', () => {
    it('runtimeOnly strips comments: positive 1, negative 0 (values differ)', () => {
        const inCode = 'const k = Object.keys;';
        const inComment = '// const k = Object.keys;';
        const count = (s: string) => (runtimeOnly(s).match(/Object\.keys(?!\()/g) || []).length;
        expect(count(inCode)).toBe(1);    // KNOWN POSITIVE
        expect(count(inComment)).toBe(0); // KNOWN NEGATIVE
    });
    it('the function counter detects a thirteenth: 12 vs 13 (values differ)', () => {
        const count = (s: string) => (runtimeOnly(s).match(/\bfunction\b/g) || []).length;
        expect(count(SRC)).toBe(12);                                    // KNOWN NEGATIVE
        expect(count(SRC + '\nfunction thirteenth() { return 1; }\n')).toBe(13); // POSITIVE
    });
    it('the parameter matcher detects a second parameter (values differ)', () => {
        const params = (s: string) => (s.match(/\(([^)]*)\)/) || ['', ''])[1];
        expect(params('function f(payload: T): void {')).toBe('payload: T');
        expect(params('function f(payload: T, options = {}): void {')).toBe('payload: T, options = {}');
    });
});

describe('D-1 -- twelve functions, no thirteenth, no function-valued binding', () => {
    const code = runtimeOnly(SRC);
    it('declares exactly twelve functions, all at module scope', () => {
        expect((code.match(/\bfunction\b/g) || []).length).toBe(12);
        const decls = SRC.split('\n').filter(l => /^(export )?function /.test(l));
        expect(decls).toHaveLength(12);
    });
    it('has zero arrow functions, classes, methods and function-valued bindings', () => {
        expect(code).not.toMatch(/=>/);
        expect(code).not.toMatch(/\bclass\b/);
        expect(code).not.toMatch(/=\s*function\b/);
        expect(code).not.toMatch(/\bnew Function\b/);
    });
    it('exports exactly the five permitted identifiers', () => {
        const names = (SRC.match(/^export function (\w+)/gm) || []).map(s => s.split(' ')[2]);
        expect(names.sort()).toEqual([
            'applySourceRightsFilter', 'jsonWithRights', 'pruneIdListArrays',
            'withholdFaersSignal', 'withholdObjectKeys',
        ]);
        expect(code).not.toMatch(/^export \{/m); // no export-brace clause
    });
});

describe('D-2 -- the four globals appear ONLY as direct-call callees', () => {
    const code = runtimeOnly(SRC);
    for (const g of ['Array.isArray', 'Object.keys', 'Response.json', 'structuredClone']) {
        it(g + ' is never a value, argument, assignment target or chain base', () => {
            const esc = g.replace('.', '\\.');
            const total = (code.match(new RegExp(esc, 'g')) || []).length;
            const callee = (code.match(new RegExp(esc + '\\(', 'g')) || []).length;
            expect(total).toBeGreaterThan(0);
            expect(callee).toBe(total);
            expect(code).not.toMatch(new RegExp(esc + '\\s*[.\\[=]'));
        });
    }
});

describe('L3S-1(a) / A-5(3) -- the applySourceRightsFilter signature pin', () => {
    it('pins the byte-exact declaration, exactly once', () => {
        const decl = 'export function applySourceRightsFilter<T>(payload: T): '
            + '{ filtered: T; withheld: WithheldTally } {';
        expect(SRC.split('\n').filter(l => l === decl)).toHaveLength(1);
    });
    it('takes exactly ONE plain parameter -- no default, no rest, no destructuring', () => {
        const params = (bodyOf('applySourceRightsFilter').match(/\(([^)]*)\)/) as RegExpMatchArray)[1];
        expect(params).toBe('payload: T');
        expect(params).not.toMatch(/[=.{[]/);
        expect(applySourceRightsFilter.length).toBe(1); // cheap second net, not the closure
    });
    it('contains no `arguments` reference anywhere in the function', () => {
        expect(runtimeOnly(bodyOf('applySourceRightsFilter'))).not.toMatch(/\barguments\b/);
        expect(runtimeOnly(bodyOf('walk'))).not.toMatch(/\barguments\b/);
    });
    it('has exactly ONE early return and no bypass branch (D-3)', () => {
        const body = runtimeOnly(bodyOf('applySourceRightsFilter'));
        expect((body.match(/\breturn\b/g) || []).length).toBe(2); // early + final
    });
});

describe('L3S-1(a) / A-5(4) -- the jsonWithRights signature pin', () => {
    it('takes exactly TWO plain parameters, no third, no default, no rest', () => {
        const params = (bodyOf('jsonWithRights').match(/\(([^)]*)\)/) as RegExpMatchArray)[1];
        expect(params).toBe('payload: unknown, init?: ResponseInit');
        expect(params.split(',')).toHaveLength(2);
        expect(params).not.toMatch(/=|\.\.\./);
    });
    it('contains no `arguments` reference', () => {
        expect(runtimeOnly(bodyOf('jsonWithRights'))).not.toMatch(/\barguments\b/);
    });
});

describe('L3S-1(b) -- behavioural second-argument probes (defence in depth)', () => {
    const probes: unknown[] = [
        undefined, null, false, 0, '', {}, [],
        { removeClaimContainers: false }, { legacy: true }, { skip: true },
        { enabled: false }, true, 1, 'legacy',
        new Proxy({}, { get: () => true }),
    ];
    const oneArg = JSON.stringify(applySourceRightsFilter(attackFixture()).filtered);
    it.each(probes.map((p, i) => [i, p]))('probe %i cannot disable containment', (_i, probe) => {
        const call = applySourceRightsFilter as unknown as (p: unknown, x: unknown) => { filtered: unknown };
        const out = JSON.stringify(call(attackFixture(), probe));
        for (const key of FROZEN_CONTAINER_KEYS) expect(out).not.toContain(key);
        expect(JSON.stringify(call(attackFixture(), probe).filtered)).toBe(oneArg);
    });
});

describe('L3S-1(c) / A-5(2) -- the legacy entry point reaches no serving path', () => {
    function srcFiles(dir: string, out: string[] = []): string[] {
        for (const e of readdirSync(dir)) {
            const p = join(dir, e);
            if (statSync(p).isDirectory()) srcFiles(p, out);
            else if (/\.(ts|tsx|js|mjs)$/.test(e)) out.push(p);
        }
        return out;
    }
    const ID = 'claimContainmentLegacyMechanisms';
    it('the scanner sees the whole of src/** (control: finds a known symbol)', () => {
        const files = srcFiles('src');
        expect(files.length).toBeGreaterThan(10);
        // KNOWN POSITIVE: jsonWithRights really does occur in several files.
        expect(files.filter(f => readFileSync(f, 'utf8').includes('jsonWithRights')).length)
            .toBeGreaterThan(1);
    });
    it('the exported identifier occurs in src/** ONLY at its own declaration', () => {
        const hits: string[] = [];
        for (const f of srcFiles('src')) {
            const n = (readFileSync(f, 'utf8').match(new RegExp(ID, 'g')) || []).length;
            for (let i = 0; i < n; i++) hits.push(f.replace(/\\/g, '/'));
        }
        expect(hits).toEqual([LEGACY_PATH]); // exactly one occurrence, in its own module
        expect(SRC).not.toContain(ID);       // including source-rights-filter.ts itself
    });
    it('the wrapper imports FROM the core, never the reverse (core stays import-free)', () => {
        expect(readFileSync(LEGACY_PATH, 'utf8')).toContain("from './source-rights-filter'");
        expect(runtimeOnly(SRC)).not.toMatch(/^\s*import\b/m);
        expect(Object.keys(claimContainmentLegacyMechanisms).sort())
            .toEqual(['pruneIdListArrays', 'withholdFaersSignal', 'withholdObjectKeys']);
    });
});

describe('3.3 -- the frozen RegExp-to-string substitution is behaviour-equivalent', () => {
    const RE = /^sciweon::neg::faers::/;
    const PREFIX = 'sciweon::neg::faers::';
    const cases = [
        'sciweon::neg::faers::x',        // exact prefix
        'sciweon::neg::faers::',         // prefix only
        'sciweon::neg::other::x',        // non-matching
        'x sciweon::neg::faers::x',      // prefix NOT at start
        '',                              // empty string
        'SCIWEON::NEG::FAERS::X',        // upper-case variant
        'sciweon::neg::faers',           // truncated prefix
        'zz::sciweon::neg::faers::x',    // prefix later in the string
    ];
    it('agrees with the removed RegExp on all eight edge cases', () => {
        for (const c of cases) expect(c.startsWith(PREFIX)).toBe(RE.test(c));
    });
    it('the RegExp carrier is gone from the module entirely', () => {
        expect(SRC).not.toContain('FAERS_NEG_ID_RE');
        expect(SRC).toContain("const FAERS_NEG_ID_PREFIX = 'sciweon::neg::faers::';");
        expect(runtimeOnly(SRC)).not.toMatch(/\.test\(/);
    });
});

describe('counting state is CALL-LOCAL (D-3.3)', () => {
    // Module scope is where a count COULD persist between calls. A string
    // primitive cannot hold state at all, so pinning module scope to exactly
    // three string constants closes that channel by construction.
    const moduleBindings = SRC.split('\n').filter(l => /^(const|let|var)\s/.test(l));
    it('the scanner is column-0 scoped (positive 1, negative 0 -- values differ)', () => {
        const at0 = 'const x = 1;';
        const indented = '    const claims: ClaimTally = { n: 0 };';
        const f = (s: string) => s.split('\n').filter(l => /^(const|let|var)\s/.test(l)).length;
        expect(f(at0)).toBe(1);      // KNOWN POSITIVE: module scope
        expect(f(indented)).toBe(0); // KNOWN NEGATIVE: function-local
    });
    it('module scope holds exactly three bindings, all string primitives', () => {
        expect(moduleBindings).toEqual([
            "const WITHHELD_STATE = 'withheld_by_rights_policy';",
            "const POLICY = 'restricted_source_rights_containment_v1';",
            "const FAERS_NEG_ID_PREFIX = 'sciweon::neg::faers::';",
        ]);
    });
    it('repeat calls carry no state forward', () => {
        const a = applySourceRightsFilter(attackFixture()).filtered as any;
        const b = applySourceRightsFilter(attackFixture()).filtered as any;
        expect(a[CLAIM_MARKER_KEY]).toEqual(b[CLAIM_MARKER_KEY]);
    });
    it('the counter is passed to walk as an EXPLICIT parameter', () => {
        expect(SRC).toContain('function walk(node: unknown, tally: WithheldTally, claims: ClaimTally): void {');
        expect(bodyOf('applySourceRightsFilter')).toContain('const claims: ClaimTally = { n: 0 };');
    });
});
