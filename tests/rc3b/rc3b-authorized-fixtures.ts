// @ts-nocheck
/**
 * Shared helpers for the RC-3B-P0B AUTHORIZED-mode tests. ALL synthetic, ZERO
 * real network: an in-memory fake client + temp files only. Builds a TEMP
 * template policy (PRODUCTION-READONLY for the PASS path, SYNTHETIC-ONLY for the
 * negative control) with the committed synthetic families, a plan bound to that
 * policy's canonical hash, and a fully-formed synthetic authorized env (anchors +
 * exact run identity). NO committed PRODUCTION-READONLY policy is ever written.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { runAuthorizedAudit } from '../../scripts/rc3b-audit/authorized-run.mjs';
import { loadTemplatePolicy, templatePolicyCanonicalSha256 } from '../../scripts/rc3b-audit/template-policy.mjs';
import { allowlistSha256, runPlanSha256 } from '../../scripts/rc3b-audit/manifest-hash.mjs';
import {
    syntheticRunManifest, makeSyntheticFakeClient, SYNTHETIC_ACCOUNT_ID,
} from '../../scripts/rc3b-audit/self-test.mjs';

export const HARNESS = 'a'.repeat(40);
export const CARRIER_TAG = 'rc3b-p0b-carrier-v0-synthetic';
export const RUN_ID = '424242';
export const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Write a TEMP template policy (committed synthetic families) with a given scope. */
export function writeTempPolicy(dir, scope) {
    const tp = loadTemplatePolicy();
    tp.policy_scope = scope;
    const p = path.join(dir, 'template-policy.json');
    fs.writeFileSync(p, JSON.stringify(tp, null, 2), 'utf-8');
    return { path: p, canonical: templatePolicyCanonicalSha256(tp) };
}

/**
 * Full authorized synthetic scenario. `policyScope` defaults to the PASS scope
 * PRODUCTION-READONLY; pass 'SYNTHETIC-ONLY' for the H4.5 negative control.
 */
export function authorizedScenario({ policyScope = 'PRODUCTION-READONLY', mutatePlan, envOverride } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc3b-authz-e2e-'));
    const policy = writeTempPolicy(dir, policyScope);
    const plan = syntheticRunManifest();
    plan.template_allowlist_sha256 = policy.canonical;
    if (mutatePlan) mutatePlan(plan);
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    const planPath = path.join(dir, 'run-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    const env = {
        RC3B_P0B_RUN_AUTHORIZED: 'true',
        GITHUB_SHA: HARNESS,
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: CARRIER_TAG,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_RUN_ID: RUN_ID,
        RC3B_AUTHORIZED_CARRIER_TAG: CARRIER_TAG,
        RC3B_AUTHORIZED_WORKFLOW_RUN_ID: RUN_ID,
        RC3B_AUTHORIZED_HARNESS_SHA: HARNESS,
        RC3B_AUTHORIZED_RUN_PLAN_SHA256: sha256File(planPath),
        RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256: sha256File(policy.path),
        RC3B_AUTHORIZED_RUN_PLAN_PATH: planPath,
        RC3B_RUN_PLAN_PATH: planPath,
        RC3B_TEMPLATE_POLICY_PATH: policy.path,
        RC3B_ALLOWED_BUCKETS: plan.bucket,
        R2_ACCOUNT_ID: SYNTHETIC_ACCOUNT_ID,
        RC3B_CARRIER_ROOT: dir,
        RC3B_OUTPUT_DIR: dir,
        ...envOverride,
    };
    return { dir, plan, planPath, policy, env };
}

/** Run the authorized chain against the in-memory fake client (ZERO real network). */
export async function runScenario(scn, clientOverride = makeSyntheticFakeClient()) {
    return runAuthorizedAudit(scn.env, { clientOverride, outDir: scn.dir, carrierRoot: scn.dir });
}

/** The full set of authorized-mode verify checks that must ALL be true on the PASS path. */
export const AUTHORIZED_ALL_GREEN = [
    'schema', 'artifact_sha256', 'leak_policy_sha256', 'scan_results_pass',
    'network_calls_after_stop', 'template_policy_canonical_sha256', 'endpoint_binding_match',
    'endpoint_evidence', 'log_bundle_sha256', 'log_scan_result', 'authorized_commit_sha',
    'authorized_run_plan_sha256', 'authorized_template_file_sha256', 'authorized_policy_scope',
    'authorized_endpoint_binding',
];
