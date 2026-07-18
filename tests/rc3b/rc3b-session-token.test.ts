// @ts-nocheck
/**
 * RC-3B-P0B-C4-E-T1 temporary R2 session-token gate. Proves the FORMAT-ONLY
 * validator (no signer / no claim parsing): a missing / blank / non-base64 /
 * decoded-not-`jwt/` / not-three-segment token throws EXACTLY one fixed, leak-free
 * code; a base64("jwt/"+JWT) token passes. Proves the PREFLIGHT fails before any
 * client / network (runAuthorizedAudit + `--check-authorization`), and that no
 * synthetic token leaks into any produced artifact or `--self-test` output.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
    assertValidSessionToken, SESSION_TOKEN_ENV, SESSION_TOKEN_ERRORS,
} from '../../scripts/rc3b-audit/session-token.mjs';
import { authorizedScenario, runScenario } from './rc3b-authorized-fixtures';

const b64 = (s) => Buffer.from(s).toString('base64');
const VALID = b64('jwt/aaa.bbb.ccc');
const tok = (v) => ({ [SESSION_TOKEN_ENV]: v });

describe('C4-E-T1 assertValidSessionToken: format-only, fixed leak-free codes (item a)', () => {
    it('a base64("jwt/"+three-segment-JWT) token PASSES and returns the raw value', () => {
        expect(assertValidSessionToken(tok(VALID))).toBe(VALID);
    });

    it('MISSING: undefined / empty / whitespace-only -> exactly SESSION_TOKEN_INVALID: MISSING', () => {
        for (const v of [undefined, '', '   ', '\t\n']) {
            expect(() => assertValidSessionToken(tok(v))).toThrow(SESSION_TOKEN_ERRORS.MISSING);
        }
        expect(() => assertValidSessionToken({})).toThrow(SESSION_TOKEN_ERRORS.MISSING);
    });

    it('NOT_BASE64: non-base64 alphabet / bad length / non-canonical padding', () => {
        for (const v of ['not base64 !!!', 'abc', '****', 'YWJj=', '=abcd']) {
            expect(() => assertValidSessionToken(tok(v))).toThrow(SESSION_TOKEN_ERRORS.NOT_BASE64);
        }
    });

    it('NOT_JWT: canonical base64 whose decoded value is not jwt/<seg>.<seg>.<seg>', () => {
        for (const decoded of [
            'hello world one two',            // no jwt/ prefix
            'jwt/aaa.bbb',                    // two segments only
            'jwt/aaa.bbb.ccc.ddd',           // four segments
            'jwt/aaa..ccc',                  // empty middle segment
            'notjwt/aaa.bbb.ccc',            // wrong prefix
            'jwt/aaa.bbb.ccc ',              // trailing space inside decoded
        ]) {
            expect(() => assertValidSessionToken(tok(b64(decoded)))).toThrow(SESSION_TOKEN_ERRORS.NOT_JWT);
        }
    });

    it('the thrown message NEVER contains the input token or any decoded fragment', () => {
        const secretDecoded = 'jwt/SEGONESECRET.SEGTWOSECRET';          // 2 segs -> NOT_JWT
        const secretToken = b64(secretDecoded);
        let msg = '';
        try { assertValidSessionToken(tok(secretToken)); } catch (e) { msg = String(e.message); }
        expect(msg).toBe(SESSION_TOKEN_ERRORS.NOT_JWT);
        for (const frag of [secretToken, secretDecoded, 'SEGONESECRET', 'SEGTWOSECRET', 'jwt/']) {
            expect(msg).not.toContain(frag);
        }
        // A NOT_BASE64 failure likewise carries none of the input.
        const bad = 'super-secret-not-base64-value-$$$';
        let msg2 = '';
        try { assertValidSessionToken(tok(bad)); } catch (e) { msg2 = String(e.message); }
        expect(msg2).toBe(SESSION_TOKEN_ERRORS.NOT_BASE64);
        expect(msg2).not.toContain('super-secret');
    });
});

describe('C4-E-T1 preflight: token gate fails BEFORE client + network (item d)', () => {
    const spy = () => ({ sends: 0, async send() { this.sends += 1; return {}; } });

    it('runAuthorizedAudit: anchors satisfied but MISSING token -> throws MISSING, 0 network', async () => {
        const scn = authorizedScenario({ envOverride: { [SESSION_TOKEN_ENV]: '' } });
        const s = spy();
        await expect(runScenario(scn, s)).rejects.toThrow(/\[RC3B CRED\] SESSION_TOKEN_INVALID: MISSING/);
        expect(s.sends).toBe(0);
    });

    it('runAuthorizedAudit: anchors satisfied but malformed token -> throws before client, 0 network', async () => {
        const scn = authorizedScenario({ envOverride: { [SESSION_TOKEN_ENV]: 'notbase64$$$' } });
        const s = spy();
        await expect(runScenario(scn, s)).rejects.toThrow(/\[RC3B CRED\] SESSION_TOKEN_INVALID/);
        expect(s.sends).toBe(0);
    });

    it('--check-authorization: anchors ok but invalid token -> exit 2 at CRED (past AUTHZ)', () => {
        const scn = authorizedScenario({ envOverride: { [SESSION_TOKEN_ENV]: 'notbase64$$$' } });
        const env = { ...process.env, ...scn.env };
        delete env.GITHUB_WORKSPACE; // isolate carrier root to scn.dir
        const r = spawnSync(process.execPath, ['scripts/rc3b-audit/run.mjs', '--check-authorization'],
            { cwd: process.cwd(), env, encoding: 'utf-8' });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/\[RC3B CRED\] SESSION_TOKEN_INVALID/);
        // Proof it PASSED the Founder anchors and failed at the token gate (reachable).
        expect(r.stderr).not.toMatch(/\[RC3B AUTHZ\]/);
    });

    it('--check-authorization: valid anchors + valid token -> exit 0 PASS', () => {
        const scn = authorizedScenario();
        const env = { ...process.env, ...scn.env };
        delete env.GITHUB_WORKSPACE;
        const r = spawnSync(process.execPath, ['scripts/rc3b-audit/run.mjs', '--check-authorization'],
            { cwd: process.cwd(), env, encoding: 'utf-8' });
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/AUTHZ\] PASS/);
    });
});

describe('C4-E-T1 leak: a synthetic token never reaches artifacts or --self-test output (item e)', () => {
    const CANARY_DECODED = 'jwt/LEAKCANARYHEAD.LEAKCANARYPAYLOAD.LEAKCANARYSIG';
    const CANARY = b64(CANARY_DECODED);
    const FRAGS = [CANARY, CANARY_DECODED, 'LEAKCANARYHEAD', 'LEAKCANARYPAYLOAD', 'LEAKCANARYSIG'];

    it('produced evidence / structural-log / locator artifacts contain no token fragment', async () => {
        // Sanity: the canary is itself a VALID token, so the run reaches artifact write.
        expect(assertValidSessionToken(tok(CANARY))).toBe(CANARY);
        const scn = authorizedScenario({ envOverride: { [SESSION_TOKEN_ENV]: CANARY } });
        const r = await runScenario(scn);
        for (const p of [r.evidencePath, r.logPath, r.locatorArtifactPath]) {
            const content = fs.readFileSync(p, 'utf-8');
            for (const frag of FRAGS) expect(content).not.toContain(frag);
        }
    });

    it('--self-test stdout/stderr contain no token fragment even with the token set', () => {
        const env = { ...process.env, [SESSION_TOKEN_ENV]: CANARY };
        const r = spawnSync(process.execPath, ['scripts/rc3b-audit/run.mjs', '--self-test'],
            { cwd: process.cwd(), env, encoding: 'utf-8' });
        expect(r.status).toBe(0);
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        for (const frag of FRAGS) expect(out).not.toContain(frag);
    });
});
