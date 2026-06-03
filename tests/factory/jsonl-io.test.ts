// @ts-nocheck
/**
 * PR-HARDEN-1 tests for the shared lib/jsonl-io.js (loadJsonlStrict + assertLoaded).
 *
 * Locks the no-silent-truncation invariant that generalizes the PR-UMLS-4b LOINC fix:
 *   (a) an ABSENT file (ENOENT) resolves []        -- legitimately empty, never a HALT;
 *   (b) a present-but-MALFORMED line THROWS          -- JSON.parse is OUTSIDE the read catch;
 *   (c) a NON-ENOENT read error (code 'EIO') THROWS  -- only ENOENT is swallowed;
 *   (d) skipComments true/false handle '#' lines, and BOTH are BYTE-IDENTICAL to the legacy
 *       split/filter parse on valid input (the byte-identical-on-valid-input constraint);
 *   (e) assertLoaded([]) / assertLoaded(undefined) THROW; assertLoaded([{...}]) does not.
 *
 * Real temp files exercise (a)/(b)/(d); a vi.spyOn-injected EIO reader exercises (c). No network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsPromises from 'node:fs/promises';
import { loadJsonlStrict, assertLoaded } from '../../scripts/factory/lib/jsonl-io.js';

// The LEGACY in-line parse each enricher used, reproduced verbatim for the byte-identical proof.
function legacyParse(content, skipComments) {
    let lines = content.split('\n').filter(Boolean);
    if (skipComments) lines = lines.filter(l => !l.startsWith('#'));
    return lines.map(l => JSON.parse(l));
}

const tmpDirs: string[] = [];
function writeTmp(name, body) {
    const dir = mkdtempSync(join(tmpdir(), 'jsonl-io-'));
    tmpDirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, body, 'utf-8');
    return file;
}

afterEach(() => {
    vi.restoreAllMocks();
    while (tmpDirs.length) {
        try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe('loadJsonlStrict -- (a) ENOENT-only swallow', () => {
    it('an ABSENT file resolves [] (legitimately empty, never a HALT)', async () => {
        const absent = join(tmpdir(), `jsonl-io-absent-${Date.now()}-${Math.trunc(1)}.jsonl`);
        await expect(loadJsonlStrict(absent)).resolves.toEqual([]);
        await expect(loadJsonlStrict(absent, { skipComments: true })).resolves.toEqual([]);
    });
});

describe('loadJsonlStrict -- (b) malformed line THROWS (not [])', () => {
    it('a present-but-MALFORMED JSONL line rejects (no silent truncation)', async () => {
        const file = writeTmp('bad.jsonl', '{"ok":1}\n{bad json}\n');
        await expect(loadJsonlStrict(file)).rejects.toThrow();
    });
    it('a single-line file with garbage rejects', async () => {
        const file = writeTmp('garbage.jsonl', 'not-json-at-all\n');
        await expect(loadJsonlStrict(file)).rejects.toThrow();
    });
});

describe('loadJsonlStrict -- (c) a non-ENOENT read error (EIO) THROWS', () => {
    it('a read error with code EIO is RE-THROWN, never read as []', async () => {
        const eio: any = new Error('simulated EIO'); eio.code = 'EIO';
        const spy = vi.spyOn(fsPromises, 'readFile').mockRejectedValue(eio);
        await expect(loadJsonlStrict('any-path.jsonl')).rejects.toThrow('simulated EIO');
        expect(spy).toHaveBeenCalled();
    });
    it('an EACCES (perms) read error is also RE-THROWN', async () => {
        const eacces: any = new Error('permission denied'); eacces.code = 'EACCES';
        vi.spyOn(fsPromises, 'readFile').mockRejectedValue(eacces);
        await expect(loadJsonlStrict('any-path.jsonl')).rejects.toThrow('permission denied');
    });
    it('ONLY ENOENT is swallowed -> []', async () => {
        const enoent: any = new Error('no such file'); enoent.code = 'ENOENT';
        vi.spyOn(fsPromises, 'readFile').mockRejectedValue(enoent);
        await expect(loadJsonlStrict('any-path.jsonl')).resolves.toEqual([]);
    });
});

describe('loadJsonlStrict -- (d) skipComments + BYTE-IDENTICAL to legacy on valid input', () => {
    const VALID = [
        { id: 'a', n: 1, nested: { x: [1, 2, 3] } },
        { id: 'b', n: 2, s: 'hello world' },
        { id: 'c', n: 3, arr: ['p', 'q'] },
    ];
    const bodyNoComment = VALID.map(r => JSON.stringify(r)).join('\n') + '\n';
    const bodyWithComment = '# Regenstrief / license header line\n' + bodyNoComment;

    it('skipComments:false KEEPS non-# content unchanged (no comment present)', async () => {
        const file = writeTmp('valid.jsonl', bodyNoComment);
        const got = await loadJsonlStrict(file, { skipComments: false });
        expect(got).toEqual(VALID);
        expect(JSON.stringify(got)).toBe(JSON.stringify(legacyParse(bodyNoComment, false)));
    });

    it('skipComments:true DROPS the leading # line; skipComments:false (the default) KEEPS it -> rejects (a # line is not JSON)', async () => {
        const file = writeTmp('commented.jsonl', bodyWithComment);
        const got = await loadJsonlStrict(file, { skipComments: true });
        expect(got).toEqual(VALID);
        // default (skipComments:false) tries to JSON.parse the '#' line -> throws (matches legacy).
        await expect(loadJsonlStrict(file, { skipComments: false })).rejects.toThrow();
        expect(() => legacyParse(bodyWithComment, false)).toThrow();
    });

    it('BYTE-IDENTICAL to legacy parse on valid input -- both skipComments modes', async () => {
        const fileNoC = writeTmp('valid2.jsonl', bodyNoComment);
        const fileWithC = writeTmp('commented2.jsonl', bodyWithComment);
        // skipComments:false on a comment-free file == legacy(false)
        expect(JSON.stringify(await loadJsonlStrict(fileNoC, { skipComments: false })))
            .toBe(JSON.stringify(legacyParse(bodyNoComment, false)));
        // skipComments:true on a commented file == legacy(true)
        expect(JSON.stringify(await loadJsonlStrict(fileWithC, { skipComments: true })))
            .toBe(JSON.stringify(legacyParse(bodyWithComment, true)));
        // skipComments:true on a comment-free file == legacy(true) (the '#' filter is a no-op)
        expect(JSON.stringify(await loadJsonlStrict(fileNoC, { skipComments: true })))
            .toBe(JSON.stringify(legacyParse(bodyNoComment, true)));
    });

    it('default opts ({}) == skipComments:false (the no-arg call path)', async () => {
        const file = writeTmp('valid3.jsonl', bodyNoComment);
        expect(await loadJsonlStrict(file)).toEqual(await loadJsonlStrict(file, { skipComments: false }));
    });

    it('blank lines are filtered (filter(Boolean)) exactly like legacy', async () => {
        const body = JSON.stringify(VALID[0]) + '\n\n' + JSON.stringify(VALID[1]) + '\n';
        const file = writeTmp('blanks.jsonl', body);
        const got = await loadJsonlStrict(file);
        expect(got).toEqual([VALID[0], VALID[1]]);
        expect(JSON.stringify(got)).toBe(JSON.stringify(legacyParse(body, false)));
    });
});

describe('assertLoaded -- (e) non-empty guard', () => {
    it('assertLoaded([]) THROWS (refuses to overwrite with empty content)', () => {
        expect(() => assertLoaded([], 'LBL', '/path/file.jsonl')).toThrow(/HALT: 0 records loaded/);
        expect(() => assertLoaded([], 'LBL', '/path/file.jsonl')).toThrow(/no silent data loss/);
    });
    it('assertLoaded(undefined) / non-array THROWS', () => {
        expect(() => assertLoaded(undefined, 'LBL', 'f')).toThrow(/HALT: 0 records loaded/);
        expect(() => assertLoaded(null, 'LBL', 'f')).toThrow(/HALT: 0 records loaded/);
        expect(() => assertLoaded({ length: 1 }, 'LBL', 'f')).toThrow(/HALT: 0 records loaded/);
    });
    it('assertLoaded([{...}]) does NOT throw', () => {
        expect(() => assertLoaded([{ id: 1 }], 'LBL', 'f')).not.toThrow();
        expect(() => assertLoaded([1, 2, 3], 'LBL', 'f')).not.toThrow();
    });
    it('the HALT message carries the label + file (loud, actionable)', () => {
        expect(() => assertLoaded([], 'SNOMED-XLINK', 'output/linked/diseases.jsonl'))
            .toThrow(/\[SNOMED-XLINK\] HALT: 0 records loaded from output\/linked\/diseases\.jsonl/);
    });
});
