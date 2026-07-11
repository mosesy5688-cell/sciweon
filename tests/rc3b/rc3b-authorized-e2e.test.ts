// @ts-nocheck
/**
 * RC-3B-P0B authorized-mode END-TO-END. Drives the full synthetic chain through
 * runAuthorizedAudit against an in-memory fake client (ZERO real network): path
 * safety -> external raw-file anchors -> EXACT run identity -> plan load ->
 * validate -> endpoint binding (fail-before-client) -> read -> evidence +
 * structural log. verifyArtifact then INDEPENDENTLY re-reads + rehashes the
 * evidence + log + run-plan + template-policy and is all-green ONLY on the PASS
 * path (a temp PRODUCTION-READONLY policy). Each listed mutation independently
 * fails the run OR the verify; a wrong account fails before the client (0 net).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { verifyArtifact } from '../../scripts/rc3b-audit/verify-artifact.mjs';
import { reasonCodeFor } from '../../scripts/rc3b-audit/harness.mjs';
import { CapExceededError } from '../../scripts/rc3b-audit/budget.mjs';
import {
    authorizedScenario, runScenario, sha256File, AUTHORIZED_ALL_GREEN,
} from './rc3b-authorized-fixtures';

const verify = (scn, result) => verifyArtifact(result.evidencePath, scn.env, result.logPath, scn.planPath, scn.policy.path);

describe('RC-3B-P0B authorized-mode e2e: PASS path (temp PRODUCTION-READONLY policy)', () => {
    it('the full chain passes and verifyArtifact is all green (no SKIPPED)', async () => {
        const scn = authorizedScenario();
        const result = await runScenario(scn);
        expect(result.schema.valid).toBe(true);
        expect(result.scanResult.pass).toBe(true);
        expect(fs.existsSync(result.logPath)).toBe(true);
        expect(result.run_metadata.carrier_tag).toBe('rc3b-p0b-carrier-v0-synthetic');
        expect(result.run_metadata.endpoint_binding_match).toBe('PASS');

        const v = await verify(scn, result);
        expect(v.ok).toBe(true);
        for (const k of AUTHORIZED_ALL_GREEN) expect(v.checks[k]).toBe(true);
        // No authorized-mode check may be 'SKIPPED'.
        for (const val of Object.values(v.checks)) expect(val).not.toBe('SKIPPED');
    });
});

describe('RC-3B-P0B authorized-mode e2e: each mutation independently FAILS', () => {
    const spy = () => ({ sends: 0, async send() { this.sends += 1; return {}; } });

    it('wrong harness SHA -> runAuthorizedAudit throws (0 network)', async () => {
        const scn = authorizedScenario({ envOverride: { RC3B_AUTHORIZED_HARNESS_SHA: 'b'.repeat(40) } });
        const s = spy();
        await expect(runScenario(scn, s)).rejects.toThrow(/MISSING_AUTHORIZATION|IDENTITY/);
        expect(s.sends).toBe(0);
    });

    it('wrong raw plan hash -> runAuthorizedAudit throws', async () => {
        const scn = authorizedScenario({ envOverride: { RC3B_AUTHORIZED_RUN_PLAN_SHA256: 'b'.repeat(64) } });
        await expect(runScenario(scn)).rejects.toThrow(/MISSING_AUTHORIZATION/);
    });

    it('wrong raw template FILE hash -> runAuthorizedAudit throws', async () => {
        const scn = authorizedScenario({ envOverride: { RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256: 'b'.repeat(64) } });
        await expect(runScenario(scn)).rejects.toThrow(/MISSING_AUTHORIZATION/);
    });

    it('wrong CANONICAL template hash (tamper plan.template_allowlist_sha256, resealed) -> INADMISSIBLE', async () => {
        const scn = authorizedScenario({ mutatePlan: (p) => { p.template_allowlist_sha256 = 'b'.repeat(64); } });
        await expect(runScenario(scn)).rejects.toThrow(/INADMISSIBLE/);
    });

    it('wrong actual account binding -> BINDING_MISMATCH BEFORE the client (0 network)', async () => {
        const scn = authorizedScenario({ envOverride: { R2_ACCOUNT_ID: 'a-different-account' } });
        const s = spy();
        await expect(runScenario(scn, s)).rejects.toThrow(/BINDING_MISMATCH/);
        expect(s.sends).toBe(0);
    });

    it('a post-hoc edited artifact -> verify artifact_sha256 fails', async () => {
        const scn = authorizedScenario();
        const result = await runScenario(scn);
        const ev = JSON.parse(fs.readFileSync(result.evidencePath, 'utf-8'));
        ev.run_metadata.tag_or_ref = 'tampered-ref';
        fs.writeFileSync(result.evidencePath, JSON.stringify(ev, null, 2), 'utf-8');
        const v = await verify(scn, result);
        expect(v.checks.artifact_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a one-byte changed structural log -> verify log_bundle_sha256 fails', async () => {
        const scn = authorizedScenario();
        const result = await runScenario(scn);
        fs.appendFileSync(result.logPath, 'X');
        const v = await verify(scn, result);
        expect(v.checks.log_bundle_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a post-run mutated run-plan FILE -> verify authorized_run_plan_sha256 fails', async () => {
        const scn = authorizedScenario();
        const result = await runScenario(scn);
        fs.appendFileSync(scn.planPath, ' ');
        const v = await verify(scn, result);
        expect(v.checks.authorized_run_plan_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a post-run mutated template-policy FILE -> verify authorized_template_file_sha256 fails', async () => {
        const scn = authorizedScenario();
        const result = await runScenario(scn);
        fs.appendFileSync(scn.policy.path, ' ');
        const v = await verify(scn, result);
        expect(v.checks.authorized_template_file_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('an INTEGRITY_ANOMALY follow-up must NOT collapse to CAP_REACHED', () => {
        const err = new CapExceededError('[RC3B BUDGET] range actual bytes 65 exceed reserved 64 (reason=INTEGRITY_ANOMALY)');
        expect(reasonCodeFor(err)).toBe('INTEGRITY_ANOMALY');
        expect(reasonCodeFor(err)).not.toBe('CAP_REACHED');
    });
});
