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
import { loadTemplatePolicy } from './template-policy.mjs';
import { loadRunManifest, validateRunManifest } from './run-manifest.mjs';
import { assertEndpointBinding } from './endpoint-binding.mjs';
import { assertRunIdentity } from './run-identity.mjs';
import { resolveCarrierInputs } from './carrier-inputs.mjs';
import { makeMinimalReadOnlyS3Client } from './client-factory.mjs';
import { runReadOnlyAudit } from './harness.mjs';
import { buildEvidenceFromRun } from './evidence-assembly.mjs';
import { serializeLogBundle } from './log-bundle.mjs';
import { buildLocatorArtifact } from './locator-artifact.mjs';
import { scanLocatorArtifact } from './leak-scanner.mjs';

export const RUN_PLAN_PATH_ENV = 'RC3B_RUN_PLAN_PATH';
export const ALLOWED_BUCKETS_ENV = 'RC3B_ALLOWED_BUCKETS';
// OPTIONAL override of the authorized template-policy FILE path (defaults to the
// committed policy). A real production carrier points this at its own audited
// PRODUCTION-READONLY policy; unset -> the committed SYNTHETIC-ONLY policy.
export const TEMPLATE_POLICY_PATH_ENV = 'RC3B_TEMPLATE_POLICY_PATH';
// OPTIONAL trusted carrier-checkout root for path safety (defaults to repo root).
export const CARRIER_ROOT_ENV = 'RC3B_CARRIER_ROOT';
export const EVIDENCE_NAME = 'rc3b-p0b-readonly-evidence.json';
export const STRUCTURAL_LOG_NAME = 'rc3b-p0b-structural-log.jsonl';
export const LOCATOR_ARTIFACT_NAME = 'rc3b-p0b-resolved-locators.json';

/**
 * @param {object} env   process.env (or an injected fake in tests)
 * @param {{clientOverride?, now?, outDir?}} opts
 * @returns {Promise<{evidence, evidencePath, logPath, run_metadata, schema, scanResult, runResult}
 *                    | {inert:true, reason:string}>}
 */
export async function runAuthorizedAudit(env, opts = {}) {
    const allowedBuckets = (env[ALLOWED_BUCKETS_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);

    // 0. PATH SAFETY (C1A-R1 / B1): the ONE shared resolver returns the RESOLVED,
    //    real, in-root run-plan + template-policy paths, anchored to the exact
    //    trusted checkout root -- BEFORE any read of those files. The SAME resolved
    //    paths are then fed to authorization + plan/policy loads (no re-read of an
    //    unresolved value).
    const resolved = resolveCarrierInputs(env, opts);
    const runPlanPath = resolved.runPlanPath;
    const templatePolicyPath = resolved.templatePolicyPath;

    // 1. EXTERNAL raw-file authorization anchors (incl. template FILE sha256) +
    //    the EXACT authorized run-plan/template PATH anchors (resolved-path equality).
    const authz = assertFounderAuthorization(env, {
        runPlanPath, templatePolicyPath, rootDir: resolved.rootDir,
    });

    // 1b. EXACT run-identity binding (CHANGE A): tag / ref-name / sha / attempt==1 /
    //     run-id -- all BEFORE the client (fail-before-client). A second independent
    //     dispatch (new run-id, attempt==1) is rejected by the run-id bind.
    const identity = assertRunIdentity(env);

    // 2. load the authorized plan.
    const { plan, rawBytes } = loadRunManifest(runPlanPath);

    // 3. validate plan + template-derivation against the EXACT authorized policy.
    const templatePolicy = loadTemplatePolicy(templatePolicyPath);
    const v = validateRunManifest(plan, { allowedBuckets, templatePolicy });
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
        allowedBuckets, clientOverride: client, now: opts.now, templatePolicy,
    });

    const run_metadata = {
        bucket: plan.bucket,
        // CHANGE C: the endpoint evidence is the COMPUTED 64-hex binding (== observed),
        // NOT the plan label or a raw account id.
        r2_endpoint_or_account_binding: binding.observed_endpoint_or_account_binding,
        carrier_tag: identity.carrier_tag,
        // C1A-R1 / B4: DIGITS-ONLY run id (no `-attempt` suffix), the attempt as a
        // separate integer (must be 1), and the exact tag ref -- so the post-verifier
        // can INDEPENDENTLY re-check run identity (run id / attempt / tag_or_ref).
        workflow_run_id: String(env.GITHUB_RUN_ID),
        workflow_run_attempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
        commit_sha: env.GITHUB_SHA || '',
        tag_or_ref: env.GITHUB_REF,
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

    // Gate 2: no locator artifact write is reachable unless every value-bearing
    // result came through the opaque same-buffer source-binding path.
    if (runResult.locator_source_results.some((r) => r.source_binding_status !== 'PASS')) {
        throw new Error('LOCATOR_SOURCE_MISMATCH -- refusing every artifact write');
    }
    const locatorBuilt = buildLocatorArtifact({
        sourceBoundResults: runResult.locator_source_results,
        objectFailures: runResult.locator_object_failures,
        plan, runMetadata: run_metadata,
    });
    const locatorScanResult = scanLocatorArtifact(locatorBuilt.artifact);
    if (!locatorBuilt.schema.valid || !locatorScanResult.pass) {
        throw new Error(`[RC3B LOCATOR] closed-schema/leak gate failed -- schema=${locatorBuilt.schema.valid} leak=${locatorScanResult.pass}`);
    }

    const outDir = opts.outDir || env.RC3B_OUTPUT_DIR || 'output';
    await fs.mkdir(outDir, { recursive: true });
    const evidencePath = path.join(outDir, EVIDENCE_NAME);
    const logPath = path.join(outDir, STRUCTURAL_LOG_NAME);
    const locatorArtifactPath = path.join(outDir, LOCATOR_ARTIFACT_NAME);
    await fs.writeFile(evidencePath, JSON.stringify(built.evidence, null, 2), 'utf-8');
    // The structural log is the SAME bytes the evidence log_bundle_sha256 hashes.
    await fs.writeFile(logPath, serializeLogBundle(runResult.logLines), 'utf-8');
    await fs.writeFile(locatorArtifactPath, JSON.stringify(locatorBuilt.artifact, null, 2), 'utf-8');

    return {
        evidence: built.evidence, evidencePath, logPath, locatorArtifactPath,
        locatorArtifact: locatorBuilt.artifact, locatorSchema: locatorBuilt.schema,
        locatorScanResult, run_metadata,
        schema: built.schema, scanResult: built.scanResult, runResult,
    };
}
