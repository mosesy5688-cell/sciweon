// @ts-nocheck
/**
 * RC-3B-P0B AUTHORIZED-mode verifier HARD semantics (CHANGE B). In authorized
 * mode a missing structural-log path, a missing run-plan path, a missing/mutated
 * template-policy, any 'SKIPPED' check, and a SYNTHETIC-ONLY policy EACH make an
 * authorized PASS impossible. The post-verifier INDEPENDENTLY re-reads + rehashes
 * the evidence + log + run-plan + template-policy files (never recorded-hash-only).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { verifyArtifact } from '../../scripts/rc3b-audit/verify-artifact.mjs';
import { runSelfTest } from '../../scripts/rc3b-audit/self-test.mjs';
import { recomputeArtifactSha256 } from '../../scripts/rc3b-audit/evidence-builder.mjs';
import { authorizedScenario, runScenario, AUTHORIZED_ALL_GREEN } from './rc3b-authorized-fixtures';

describe('RC-3B-P0B authorized verifier: missing inputs are HARD FAILS (never SKIPPED)', () => {
    it('a missing resolved-locators path -> FAIL', async () => {
        const scn = authorizedScenario(); const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, r.logPath, scn.planPath, scn.policy.path);
        expect(v.checks.locator_external_join).toBe(false);
        expect(v.checks.locator_leak_scan).toBe(false);
        expect(v.ok).toBe(false);
    });
    it('a missing structural-log path -> FAIL (H4.1)', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, undefined, scn.planPath, scn.policy.path, r.locatorArtifactPath);
        expect(v.checks.log_bundle_sha256).toBe(false);
        expect(v.checks.log_scan_result).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a missing run-plan path -> FAIL (H4.2)', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, r.logPath, undefined, scn.policy.path, r.locatorArtifactPath);
        expect(v.checks.authorized_run_plan_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a missing template-policy path -> FAIL (H4.2b + H4.5)', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, r.logPath, scn.planPath, undefined, r.locatorArtifactPath);
        expect(v.checks.authorized_template_file_sha256).toBe(false);
        expect(v.checks.authorized_policy_scope).toBe(false);
        expect(v.ok).toBe(false);
    });
});

describe('RC-3B-P0B authorized verifier: no SKIPPED can yield an authorized PASS (H4.4)', () => {
    it('a clean artifact verified in AUTHORIZED mode with NO anchors/paths -> every check is a hard boolean, ok:false', async () => {
        const ev = (await runSelfTest()).evidence;
        const v = await verifyArtifact(ev, { RC3B_P0B_RUN_AUTHORIZED: 'true' });
        for (const val of Object.values(v.checks)) expect(val).not.toBe('SKIPPED');
        expect(v.ok).toBe(false);
    });
});

describe('RC-3B-P0B authorized verifier: SYNTHETIC-ONLY policy fails H4.5 (negative control)', () => {
    it('the SAME chain with a SYNTHETIC-ONLY policy fails ONLY on authorized_policy_scope', async () => {
        const scn = authorizedScenario({ policyScope: 'SYNTHETIC-ONLY' });
        const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, r.logPath, scn.planPath, scn.policy.path, r.locatorArtifactPath);
        expect(v.checks.authorized_policy_scope).toBe(false);
        expect(v.ok).toBe(false);
        for (const k of AUTHORIZED_ALL_GREEN) {
            if (k !== 'authorized_policy_scope') expect(v.checks[k]).toBe(true);
        }
    });
});

// ---- C1A-R1 / B4: INDEPENDENT post-verifier run-identity checks ---------------
function reseal(evPath, mutate) {
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf-8'));
    mutate(ev.run_metadata);
    ev.integrity_evidence.artifact_sha256 = recomputeArtifactSha256(ev);
    fs.writeFileSync(evPath, JSON.stringify(ev, null, 2), 'utf-8');
}
const verifyId = (scn, r, envOver = {}) => verifyArtifact(r.evidencePath, { ...scn.env, ...envOver }, r.logPath, scn.planPath, scn.policy.path, r.locatorArtifactPath);

describe('RC-3B-P0B authorized verifier: INDEPENDENT run-identity (carrier_tag / run_id / attempt / tag_or_ref)', () => {
    it('all exact identity fields aligned -> the four identity checks PASS', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyId(scn, r);
        expect(v.checks.authorized_carrier_tag).toBe(true);
        expect(v.checks.authorized_workflow_run_id).toBe(true);
        expect(v.checks.authorized_workflow_run_attempt).toBe(true);
        expect(v.checks.authorized_tag_ref).toBe(true);
        expect(v.ok).toBe(true);
    });

    it('artifact wrong carrier_tag -> authorized_carrier_tag FAIL', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        reseal(r.evidencePath, (rm) => { rm.carrier_tag = 'rc3b-p0b-carrier-OTHER'; });
        const v = await verifyId(scn, r);
        expect(v.checks.authorized_carrier_tag).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('artifact wrong workflow_run_id -> authorized_workflow_run_id FAIL', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        reseal(r.evidencePath, (rm) => { rm.workflow_run_id = '999'; });
        const v = await verifyId(scn, r);
        expect(v.checks.authorized_workflow_run_id).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('env wrong GITHUB_RUN_ID (artifact rm ok) -> authorized_workflow_run_id FAIL', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyId(scn, r, { GITHUB_RUN_ID: '777777' });
        expect(v.checks.authorized_workflow_run_id).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('wrong workflow_run_attempt (env attempt 2) -> authorized_workflow_run_attempt FAIL', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyId(scn, r, { GITHUB_RUN_ATTEMPT: '2' });
        expect(v.checks.authorized_workflow_run_attempt).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('branch tag_or_ref (not refs/tags/...) -> authorized_tag_ref FAIL', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyId(scn, r, { GITHUB_REF: 'refs/heads/main', GITHUB_REF_TYPE: 'branch' });
        expect(v.checks.authorized_tag_ref).toBe(false);
        expect(v.ok).toBe(false);
    });
});
