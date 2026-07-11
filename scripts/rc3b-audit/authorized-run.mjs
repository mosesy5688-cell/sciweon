/**
 * RC-3B-P0B -- authorized-mode READ-ONLY R2 run (the CHANGE-B execution order).
 *
 * runAuthorizedAudit enforces a STRICT fail-before-client order:
 *   1. verify the EXTERNAL raw-file Founder authorization anchors (commit +
 *      run-plan file bytes + template-policy FILE bytes) -- assertFounderAuthorization;
 *   2. load the authorized plan;
 *   3. validate plan + template-derivation (throw if inadmissible);
 *   4/5. RE-DERIVE the actual R2 account/endpoint binding from the environment and
 *      assert it EQUALS the plan's authorized binding (assertEndpointBinding) --
 *      a wrong account fails HERE, before any client, with zero network;
 *   6. ONLY THEN construct the minimal read-only S3 client;
 *   7. ONLY THEN touch the network.
 * It then builds the evidence artifact, WRITES it plus the real structural-log
 * bundle (whose sha256 the evidence records), and returns the handles. This
 * module carries @aws-sdk-backed deps, so run.mjs imports it LAZILY (after npm ci).
 */

import fs from 'fs/promises';
import path from 'path';
import { assertFounderAuthorization } from './authorization.mjs';
import { TEMPLATE_POLICY_PATH } from './template-policy.mjs';
import { loadRunManifest, validateRunManifest } from './run-manifest.mjs';
import { assertEndpointBinding } from './endpoint-binding.mjs';
import { makeMinimalReadOnlyS3Client } from './client-factory.mjs';
import { runReadOnlyAudit } from './harness.mjs';
import { buildEvidenceFromRun } from './evidence-assembly.mjs';
import { serializeLogBundle } from './log-bundle.mjs';

export const RUN_PLAN_PATH_ENV = 'RC3B_RUN_PLAN_PATH';
export const ALLOWED_BUCKETS_ENV = 'RC3B_ALLOWED_BUCKETS';
export const EVIDENCE_NAME = 'rc3b-p0b-readonly-evidence.json';
export const STRUCTURAL_LOG_NAME = 'rc3b-p0b-structural-log.jsonl';

/**
 * @param {object} env   process.env (or an injected fake in tests)
 * @param {{clientOverride?, now?, outDir?}} opts
 * @returns {Promise<{evidence, evidencePath, logPath, run_metadata, schema, scanResult, runResult}
 *                    | {inert:true, reason:string}>}
 */
export async function runAuthorizedAudit(env, opts = {}) {
    const runPlanPath = env[RUN_PLAN_PATH_ENV];
    const allowedBuckets = (env[ALLOWED_BUCKETS_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);

    // 1. EXTERNAL raw-file authorization anchors (incl. template FILE sha256).
    const authz = assertFounderAuthorization(env, { runPlanPath, templatePolicyPath: TEMPLATE_POLICY_PATH });

    // 2. load the authorized plan.
    const { plan, rawBytes } = loadRunManifest(runPlanPath);

    // 3. validate plan + template-derivation (fail-before-network on any gap).
    const v = validateRunManifest(plan, { allowedBuckets });
    if (!v.admissible) {
        throw new Error(`[RC3B AUTHZ-RUN] run manifest INADMISSIBLE -- fail-before-network:\n - ${v.errors.join('\n - ')}`);
    }

    // 4/5. RE-DERIVE + assert the actual account/endpoint binding == authorized.
    const binding = assertEndpointBinding(env, plan);

    // 6. ONLY THEN construct the read-only client.
    const client = opts.clientOverride || makeMinimalReadOnlyS3Client(env);
    if (!client) return { inert: true, reason: 'no read-only credentials provisioned' };

    // 7. ONLY THEN network.
    const runResult = await runReadOnlyAudit(plan, rawBytes, {
        allowedBuckets, clientOverride: client, now: opts.now,
    });

    const run_metadata = {
        bucket: plan.bucket,
        r2_endpoint_or_account_id: plan.endpoint_or_account_binding,
        workflow_run_id: env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}` : 'local',
        commit_sha: env.GITHUB_SHA || '',
        tag_or_ref: env.GITHUB_REF || 'local',
        materialized_run_plan_sha256: plan.materialized_run_plan_sha256,
        template_allowlist_sha256: plan.template_allowlist_sha256,
        materialized_allowlist_sha256: plan.materialized_allowlist_sha256,
        authorized_harness_sha: authz.authorized_harness_sha,
        authorized_run_plan_sha256: authz.authorized_run_plan_sha256,
        authorized_template_file_sha256: authz.authorized_template_file_sha256,
        authorized_endpoint_or_account_binding: binding.authorized_endpoint_or_account_binding,
        observed_endpoint_or_account_binding: binding.observed_endpoint_or_account_binding,
        endpoint_binding_match: binding.endpoint_binding_match,
        mode: 'READ-ONLY-R2',
        status: runResult.partial ? 'PARTIAL' : 'RUNTIME-OBSERVED',
    };
    const built = buildEvidenceFromRun(runResult, plan, { run_metadata });

    const outDir = opts.outDir || env.RC3B_OUTPUT_DIR || 'output';
    await fs.mkdir(outDir, { recursive: true });
    const evidencePath = path.join(outDir, EVIDENCE_NAME);
    const logPath = path.join(outDir, STRUCTURAL_LOG_NAME);
    await fs.writeFile(evidencePath, JSON.stringify(built.evidence, null, 2), 'utf-8');
    // The structural log is the SAME bytes the evidence log_bundle_sha256 hashes.
    await fs.writeFile(logPath, serializeLogBundle(runResult.logLines), 'utf-8');

    return {
        evidence: built.evidence, evidencePath, logPath, run_metadata,
        schema: built.schema, scanResult: built.scanResult, runResult,
    };
}
