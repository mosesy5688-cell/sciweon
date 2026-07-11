// @ts-nocheck
/**
 * RC-3B-P0B AUTHORIZED-mode verifier HARD semantics (CHANGE B). In authorized
 * mode a missing structural-log path, a missing run-plan path, a missing/mutated
 * template-policy, any 'SKIPPED' check, and a SYNTHETIC-ONLY policy EACH make an
 * authorized PASS impossible. The post-verifier INDEPENDENTLY re-reads + rehashes
 * the evidence + log + run-plan + template-policy files (never recorded-hash-only).
 */
import { describe, it, expect } from 'vitest';
import { verifyArtifact } from '../../scripts/rc3b-audit/verify-artifact.mjs';
import { runSelfTest } from '../../scripts/rc3b-audit/self-test.mjs';
import { authorizedScenario, runScenario, AUTHORIZED_ALL_GREEN } from './rc3b-authorized-fixtures';

describe('RC-3B-P0B authorized verifier: missing inputs are HARD FAILS (never SKIPPED)', () => {
    it('a missing structural-log path -> FAIL (H4.1)', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, undefined, scn.planPath, scn.policy.path);
        expect(v.checks.log_bundle_sha256).toBe(false);
        expect(v.checks.log_scan_result).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a missing run-plan path -> FAIL (H4.2)', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, r.logPath, undefined, scn.policy.path);
        expect(v.checks.authorized_run_plan_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a missing template-policy path -> FAIL (H4.2b + H4.5)', async () => {
        const scn = authorizedScenario();
        const r = await runScenario(scn);
        const v = await verifyArtifact(r.evidencePath, scn.env, r.logPath, scn.planPath, undefined);
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
        const v = await verifyArtifact(r.evidencePath, scn.env, r.logPath, scn.planPath, scn.policy.path);
        expect(v.checks.authorized_policy_scope).toBe(false);
        expect(v.ok).toBe(false);
        for (const k of AUTHORIZED_ALL_GREEN) {
            if (k !== 'authorized_policy_scope') expect(v.checks[k]).toBe(true);
        }
    });
});
