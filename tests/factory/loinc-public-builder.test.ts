// @ts-nocheck
/**
 * PR-UMLS-4 COMPLIANCE test for loinc-public-builder.js (the Cat-0 public projection builder).
 *
 * The builder reads the FULL stamped output/linked/loinc-concepts.jsonl (cui-bearing) and must
 * emit output/linked/loinc-concepts-public.jsonl with: a leading `#`-comment Regenstrief
 * attribution header line, then EXACTLY {sid_s,sid_c,code,str} per concept -- NO cui. This test
 * runs the REAL script in a temp cwd, string-scans for the input cui (must be ABSENT), asserts
 * the exact key set, the verbatim Regenstrief header, and the HALT guards (empty / missing-sid).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BUILDER = resolve('scripts/factory/loinc-public-builder.js');
const INPUT_CUI = 'C0427843';

// Full stamped internal concepts (cui-bearing). preferred_str/synonyms are SYNTHETIC placeholders.
const FULL_CONCEPTS = [
    {
        code: '34084-4', cui: INPUT_CUI, sab: 'LNC', tty: 'LN',
        preferred_str: 'PREFERRED-STR-PLACEHOLDER', synonyms: ['SYN-A', 'SYN-B'],
        anchor_payload: 'LNC:34084-4', canonicalization_version: 'loinc.concept.v1.0',
        sid_s: 'fcb5f8a230b0ae535b7dd7590dad9b22', sid_c: '7bbcc7c95cdb309e1de11b039847b714',
    },
    {
        code: '2951-2', cui: 'C0337438', sab: 'LNC', tty: 'LN',
        preferred_str: 'PREFERRED-STR-2', synonyms: [],
        anchor_payload: 'LNC:2951-2', canonicalization_version: 'loinc.concept.v1.0',
        sid_s: '3c455697051356ac917c15020442f95b', sid_c: '1111222233334444555566667777888',
    },
];

function runBuilder(jsonlBody) {
    const workDir = mkdtempSync(join(tmpdir(), 'loinc-public-builder-'));
    mkdirSync(join(workDir, 'output', 'linked'), { recursive: true });
    writeFileSync(join(workDir, 'output', 'linked', 'loinc-concepts.jsonl'), jsonlBody, 'utf-8');
    const result = spawnSync(process.execPath, [BUILDER], { cwd: workDir, encoding: 'utf-8' });
    return { workDir, result };
}

let workDir;
let rawPublic;
let publicLines;

beforeAll(() => {
    const jsonl = FULL_CONCEPTS.map(c => JSON.stringify(c)).join('\n') + '\n';
    const r = runBuilder(jsonl);
    workDir = r.workDir;
    if (r.result.status !== 0) {
        throw new Error(`loinc-public-builder exit ${r.result.status}\nstdout:\n${r.result.stdout}\nstderr:\n${r.result.stderr}`);
    }
    rawPublic = readFileSync(join(workDir, 'output', 'linked', 'loinc-concepts-public.jsonl'), 'utf-8');
    publicLines = rawPublic.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => JSON.parse(l));
});

afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('loinc-public-builder emits cui-free {sid_s,sid_c,code,str} + Regenstrief header', () => {
    it('emits one public record per input concept', () => {
        expect(publicLines).toHaveLength(FULL_CONCEPTS.length);
    });

    it('every record has EXACTLY {sid_s,sid_c,code,str} -- no cui/synonyms/sab/tty', () => {
        for (const rec of publicLines) {
            expect(Object.keys(rec).sort()).toEqual(['code', 'sid_c', 'sid_s', 'str']);
            expect(Object.prototype.hasOwnProperty.call(rec, 'cui')).toBe(false);
        }
        expect(publicLines[0]).toEqual({
            sid_s: 'fcb5f8a230b0ae535b7dd7590dad9b22',
            sid_c: '7bbcc7c95cdb309e1de11b039847b714',
            code: '34084-4',
            str: 'PREFERRED-STR-PLACEHOLDER',
        });
    });

    it('string-scan: the input cui value is ABSENT from the entire public artifact', () => {
        expect(rawPublic).not.toContain(INPUT_CUI);
        expect(rawPublic).not.toContain('C0337438');
    });

    it('the verbatim Regenstrief attribution rides in a leading #-comment header line', () => {
        const headerLine = rawPublic.split('\n').find(l => l.startsWith('#'));
        expect(headerLine).toBeTruthy();
        const meta = JSON.parse(headerLine.slice(1));
        expect(typeof meta.loinc_attribution).toBe('string');
        // Verbatim markers from the founder-locked notice (incl the (R) registered sign).
        expect(meta.loinc_attribution).toContain('Regenstrief Institute, Inc.');
        expect(meta.loinc_attribution).toContain('LOINC®');
        expect(meta.loinc_attribution).toContain('loinc.org/license');
        expect(meta.loinc_attribution).toContain('copyright © 1995-2026');
    });
});

describe('HALT guards (no silent empty/short public artifact)', () => {
    it('HALT on empty input (0 concepts)', () => {
        const r = runBuilder('');
        expect(r.result.status).not.toBe(0);
        expect(r.result.stderr).toContain('HALT');
        rmSync(r.workDir, { recursive: true, force: true });
    });

    it('HALT on a concept missing sid_s/sid_c post-stamp', () => {
        const broken = { code: '718-7', cui: 'C0000099', preferred_str: 'X', anchor_payload: 'LNC:718-7', canonicalization_version: 'loinc.concept.v1.0' };
        const r = runBuilder(JSON.stringify(broken) + '\n');
        expect(r.result.status).not.toBe(0);
        expect(r.result.stderr).toContain('missing sid_s/sid_c');
        rmSync(r.workDir, { recursive: true, force: true });
    });
});
