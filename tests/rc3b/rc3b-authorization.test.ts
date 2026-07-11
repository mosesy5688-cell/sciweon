// @ts-nocheck
/**
 * RC-3B-P0B external Founder authorization anchors (fail-before-client). Proves
 * assertFounderAuthorization passes ONLY with a fully-formed, file-bytes-bound
 * synthetic env and throws MISSING_AUTHORIZATION on every individual gap, and
 * that `run.mjs --run` exits 2 (inert) when no anchors are provisioned.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { assertFounderAuthorization, sha256OfFileBytes } from '../../scripts/rc3b-audit/authorization.mjs';
import { TEMPLATE_POLICY_PATH } from '../../scripts/rc3b-audit/template-policy.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc3b-authz-'));
const runPlanPath = path.join(dir, 'run-plan.json');
fs.writeFileSync(runPlanPath, JSON.stringify({ synthetic: true, n: 1 }), 'utf-8');
const HARNESS = 'a'.repeat(40);

function goodEnv() {
    return {
        RC3B_P0B_RUN_AUTHORIZED: 'true',
        RC3B_AUTHORIZED_HARNESS_SHA: HARNESS,
        RC3B_AUTHORIZED_RUN_PLAN_SHA256: sha256OfFileBytes(runPlanPath),
        RC3B_AUTHORIZED_TEMPLATE_SHA256: sha256OfFileBytes(TEMPLATE_POLICY_PATH),
        RC3B_AUTHORIZED_RUN_PLAN_PATH: runPlanPath,
        GITHUB_SHA: HARNESS,
    };
}
const OPTS = { runPlanPath, templatePolicyPath: TEMPLATE_POLICY_PATH };

describe('RC-3B-P0B authorization: PASS only when fully bound', () => {
    it('a fully-formed synthetic env authorizes and returns the three anchors', () => {
        const r = assertFounderAuthorization(goodEnv(), OPTS);
        expect(r.ok).toBe(true);
        expect(r.authorized_harness_sha).toBe(HARNESS);
        expect(r.authorized_run_plan_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.authorized_template_sha256).toBe(sha256OfFileBytes(TEMPLATE_POLICY_PATH));
    });
});

describe('RC-3B-P0B authorization: MISSING_AUTHORIZATION on every gap', () => {
    const M = /\[RC3B AUTHZ\] MISSING_AUTHORIZATION:/;
    it('RUN_AUTHORIZED != true', () => {
        expect(() => assertFounderAuthorization({ ...goodEnv(), RC3B_P0B_RUN_AUTHORIZED: 'false' }, OPTS)).toThrow(M);
    });
    it('an anchor is missing', () => {
        const e = goodEnv(); delete e.RC3B_AUTHORIZED_HARNESS_SHA;
        expect(() => assertFounderAuthorization(e, OPTS)).toThrow(M);
    });
    it('harness SHA not 40-hex', () => {
        expect(() => assertFounderAuthorization({ ...goodEnv(), RC3B_AUTHORIZED_HARNESS_SHA: 'nothex' }, OPTS)).toThrow(M);
    });
    it('run-plan SHA not 64-hex', () => {
        expect(() => assertFounderAuthorization({ ...goodEnv(), RC3B_AUTHORIZED_RUN_PLAN_SHA256: 'abc' }, OPTS)).toThrow(M);
    });
    it('GITHUB_SHA != authorized harness SHA', () => {
        expect(() => assertFounderAuthorization({ ...goodEnv(), GITHUB_SHA: 'b'.repeat(40) }, OPTS)).toThrow(M);
    });
    it('run-plan path != authorized path', () => {
        expect(() => assertFounderAuthorization(goodEnv(), { runPlanPath: `${runPlanPath}.other`, templatePolicyPath: TEMPLATE_POLICY_PATH })).toThrow(M);
    });
    it('run-plan file bytes hash mismatch', () => {
        expect(() => assertFounderAuthorization({ ...goodEnv(), RC3B_AUTHORIZED_RUN_PLAN_SHA256: 'a'.repeat(64) }, OPTS)).toThrow(M);
    });
    it('template file bytes hash mismatch', () => {
        expect(() => assertFounderAuthorization({ ...goodEnv(), RC3B_AUTHORIZED_TEMPLATE_SHA256: 'a'.repeat(64) }, OPTS)).toThrow(M);
    });
});

describe('RC-3B-P0B authorization: run.mjs --run is inert (exit 2) with no anchors', () => {
    it('exits 2 and never opens a client', () => {
        const env = { ...process.env };
        delete env.RC3B_P0B_RUN_AUTHORIZED;
        const r = spawnSync(process.execPath, ['scripts/rc3b-audit/run.mjs', '--run'], { cwd: process.cwd(), env, encoding: 'utf-8' });
        expect(r.status).toBe(2);
    });
});
