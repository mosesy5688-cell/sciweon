// @ts-nocheck
/**
 * PR-UMLS-2a COMPLIANCE test for mesh-public-builder.js (the breach-fix builder).
 *
 * The builder reads the FULL stamped output/linked/mesh-concepts.jsonl (cui-bearing) and
 * must emit output/linked/mesh-concepts-public.jsonl containing EXACTLY {sid_s,sid_c,code,str}
 * per concept -- NO cui. This test runs the REAL script in a temp cwd, then string-scans the
 * emitted public file for the input cui value (must be ABSENT) and asserts the exact key set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BUILDER = resolve('scripts/factory/mesh-public-builder.js');
const INPUT_CUI = 'C0001688';

// Full stamped internal concepts (cui-bearing). preferred_str/synonyms are placeholders.
const FULL_CONCEPTS = [
    {
        code: 'D000818', cui: INPUT_CUI, sab: 'MSH', tty: 'PT',
        preferred_str: 'PREFERRED-STR-PLACEHOLDER', synonyms: ['SYN-A', 'SYN-B'],
        anchor_payload: 'MSH:D000818', canonicalization_version: 'mesh.concept.v1.0',
        sid_s: '40374b17c32e1493bd60b96c1c2bd2c6', sid_c: 'be507120e7ea5dcd273f57761fada499',
    },
    {
        code: 'D006801', cui: 'C0020114', sab: 'MSH', tty: 'PT',
        preferred_str: 'PREFERRED-STR-2', synonyms: [],
        anchor_payload: 'MSH:D006801', canonicalization_version: 'mesh.concept.v1.0',
        sid_s: 'aaaa0000bbbb1111cccc2222dddd3333', sid_c: '1111222233334444555566667777888',
    },
];

let workDir;
let publicLines;

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mesh-public-builder-'));
    mkdirSync(join(workDir, 'output', 'linked'), { recursive: true });
    const jsonl = FULL_CONCEPTS.map(c => JSON.stringify(c)).join('\n') + '\n';
    writeFileSync(join(workDir, 'output', 'linked', 'mesh-concepts.jsonl'), jsonl, 'utf-8');

    const result = spawnSync(process.execPath, [BUILDER], { cwd: workDir, encoding: 'utf-8' });
    if (result.status !== 0) {
        throw new Error(`mesh-public-builder exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const raw = readFileSync(join(workDir, 'output', 'linked', 'mesh-concepts-public.jsonl'), 'utf-8');
    publicLines = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
});

afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('mesh-public-builder emits cui-free {sid_s,sid_c,code,str}', () => {
    it('emits one public record per input concept', () => {
        expect(publicLines).toHaveLength(FULL_CONCEPTS.length);
    });

    it('every record has EXACTLY {sid_s,sid_c,code,str} -- no cui/synonyms/sab/tty', () => {
        for (const rec of publicLines) {
            expect(Object.keys(rec).sort()).toEqual(['code', 'sid_c', 'sid_s', 'str']);
            expect(Object.prototype.hasOwnProperty.call(rec, 'cui')).toBe(false);
        }
        expect(publicLines[0]).toEqual({
            sid_s: '40374b17c32e1493bd60b96c1c2bd2c6',
            sid_c: 'be507120e7ea5dcd273f57761fada499',
            code: 'D000818',
            str: 'PREFERRED-STR-PLACEHOLDER',
        });
    });

    it('string-scan: the input cui value is ABSENT from the entire public artifact', () => {
        const raw = readFileSync(join(workDir, 'output', 'linked', 'mesh-concepts-public.jsonl'), 'utf-8');
        expect(raw).not.toContain(INPUT_CUI);
        expect(raw).not.toContain('C0020114');
    });
});
