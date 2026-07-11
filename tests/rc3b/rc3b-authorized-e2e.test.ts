// @ts-nocheck
/**
 * RC-3B-P0B authorized-mode END-TO-END (CHANGE E). Drives the full synthetic
 * chain through runAuthorizedAudit against an in-memory fake client (ZERO real
 * network): external raw-file anchors -> plan load -> validate -> endpoint binding
 * (fail-before-client) -> read -> evidence + structural log. verifyArtifact then
 * re-checks EVERY dimension. Each listed mutation INDEPENDENTLY makes the run OR
 * the verify fail; a wrong account fails before the client with 0 network calls.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { runAuthorizedAudit } from '../../scripts/rc3b-audit/authorized-run.mjs';
import { verifyArtifact } from '../../scripts/rc3b-audit/verify-artifact.mjs';
import { reasonCodeFor } from '../../scripts/rc3b-audit/harness.mjs';
import { CapExceededError } from '../../scripts/rc3b-audit/budget.mjs';
import { TEMPLATE_POLICY_PATH } from '../../scripts/rc3b-audit/template-policy.mjs';
import { allowlistSha256, runPlanSha256 } from '../../scripts/rc3b-audit/manifest-hash.mjs';
import {
    syntheticRunManifest, makeSyntheticFakeClient, SYNTHETIC_ACCOUNT_ID,
} from '../../scripts/rc3b-audit/self-test.mjs';

const HARNESS = 'a'.repeat(40);
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function reseal(plan) {
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    return plan;
}

/** Fresh temp dir + written run-plan + a fully-formed synthetic authorized env. */
function scenario({ mutatePlan, envOverride } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc3b-e2e-'));
    const plan = syntheticRunManifest();
    if (mutatePlan) mutatePlan(plan);
    const planPath = path.join(dir, 'run-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    const env = {
        RC3B_P0B_RUN_AUTHORIZED: 'true',
        GITHUB_SHA: HARNESS,
        RC3B_AUTHORIZED_HARNESS_SHA: HARNESS,
        RC3B_AUTHORIZED_RUN_PLAN_SHA256: sha256File(planPath),
        RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256: sha256File(TEMPLATE_POLICY_PATH),
        RC3B_AUTHORIZED_RUN_PLAN_PATH: planPath,
        RC3B_RUN_PLAN_PATH: planPath,
        RC3B_ALLOWED_BUCKETS: plan.bucket,
        R2_ACCOUNT_ID: SYNTHETIC_ACCOUNT_ID,
        RC3B_OUTPUT_DIR: dir,
        ...envOverride,
    };
    return { dir, plan, planPath, env };
}

const ALL_GREEN = [
    'schema', 'artifact_sha256', 'leak_policy_sha256', 'scan_results_pass',
    'network_calls_after_stop', 'template_policy_canonical_sha256', 'endpoint_binding_match',
    'log_bundle_sha256', 'log_scan_result', 'authorized_commit_sha', 'authorized_run_plan_sha256',
    'authorized_template_file_sha256', 'authorized_endpoint_binding',
];

describe('RC-3B-P0B authorized-mode e2e: success path', () => {
    it('the full chain passes and verifyArtifact is all green', async () => {
        const { dir, env } = scenario();
        const result = await runAuthorizedAudit(env, { clientOverride: makeSyntheticFakeClient(), outDir: dir });
        expect(result.schema.valid).toBe(true);
        expect(result.scanResult.pass).toBe(true);
        expect(fs.existsSync(result.logPath)).toBe(true);
        expect(result.run_metadata.endpoint_binding_match).toBe('PASS');

        const v = await verifyArtifact(result.evidencePath, env, result.logPath);
        expect(v.ok).toBe(true);
        for (const k of ALL_GREEN) expect(v.checks[k]).toBe(true);
    });
});

describe('RC-3B-P0B authorized-mode e2e: each mutation independently FAILS', () => {
    it('wrong harness SHA -> runAuthorizedAudit throws', async () => {
        const { dir, env } = scenario({ envOverride: { RC3B_AUTHORIZED_HARNESS_SHA: 'b'.repeat(40) } });
        await expect(runAuthorizedAudit(env, { clientOverride: makeSyntheticFakeClient(), outDir: dir })).rejects.toThrow(/MISSING_AUTHORIZATION/);
    });

    it('wrong raw plan hash -> runAuthorizedAudit throws', async () => {
        const { dir, env } = scenario({ envOverride: { RC3B_AUTHORIZED_RUN_PLAN_SHA256: 'b'.repeat(64) } });
        await expect(runAuthorizedAudit(env, { clientOverride: makeSyntheticFakeClient(), outDir: dir })).rejects.toThrow(/MISSING_AUTHORIZATION/);
    });

    it('wrong raw template FILE hash -> runAuthorizedAudit throws', async () => {
        const { dir, env } = scenario({ envOverride: { RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256: 'b'.repeat(64) } });
        await expect(runAuthorizedAudit(env, { clientOverride: makeSyntheticFakeClient(), outDir: dir })).rejects.toThrow(/MISSING_AUTHORIZATION/);
    });

    it('wrong CANONICAL template hash (tamper plan.template_allowlist_sha256, resealed) -> INADMISSIBLE', async () => {
        const { dir, env } = scenario({ mutatePlan: (p) => { p.template_allowlist_sha256 = 'b'.repeat(64); reseal(p); } });
        await expect(runAuthorizedAudit(env, { clientOverride: makeSyntheticFakeClient(), outDir: dir })).rejects.toThrow(/INADMISSIBLE/);
    });

    it('wrong actual account binding -> BINDING_MISMATCH BEFORE the client (0 network calls)', async () => {
        const { dir, env } = scenario({ envOverride: { R2_ACCOUNT_ID: 'a-different-account' } });
        const spy = { sends: 0, async send() { this.sends += 1; return {}; } };
        await expect(runAuthorizedAudit(env, { clientOverride: spy, outDir: dir })).rejects.toThrow(/BINDING_MISMATCH/);
        expect(spy.sends).toBe(0);
    });

    it('a post-hoc edited artifact -> verify artifact_sha256 fails', async () => {
        const { dir, env } = scenario();
        const result = await runAuthorizedAudit(env, { clientOverride: makeSyntheticFakeClient(), outDir: dir });
        const ev = JSON.parse(fs.readFileSync(result.evidencePath, 'utf-8'));
        ev.run_metadata.tag_or_ref = 'tampered-ref';
        fs.writeFileSync(result.evidencePath, JSON.stringify(ev, null, 2), 'utf-8');
        const v = await verifyArtifact(result.evidencePath, env, result.logPath);
        expect(v.checks.artifact_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('a one-byte changed structural log -> verify log_bundle_sha256 fails', async () => {
        const { dir, env } = scenario();
        const result = await runAuthorizedAudit(env, { clientOverride: makeSyntheticFakeClient(), outDir: dir });
        fs.appendFileSync(result.logPath, 'X');
        const v = await verifyArtifact(result.evidencePath, env, result.logPath);
        expect(v.checks.log_bundle_sha256).toBe(false);
        expect(v.ok).toBe(false);
    });

    it('an INTEGRITY_ANOMALY follow-up must NOT collapse to CAP_REACHED', () => {
        const err = new CapExceededError('[RC3B BUDGET] range actual bytes 65 exceed reserved 64 (reason=INTEGRITY_ANOMALY)');
        expect(reasonCodeFor(err)).toBe('INTEGRITY_ANOMALY');
        expect(reasonCodeFor(err)).not.toBe('CAP_REACHED');
    });
});
