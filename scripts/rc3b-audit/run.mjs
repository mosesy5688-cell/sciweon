/**
 * RC-3B-P0B -- CLI entry. INERT by default.
 *
 *   node scripts/rc3b-audit/run.mjs --self-test
 *       OFFLINE synthetic verification (schema + leak positive/negative
 *       controls + hash consistency). No network, no secrets, no run plan.
 *
 *   node scripts/rc3b-audit/run.mjs --run
 *       The real READ-ONLY R2 audit. FAILS CLOSED unless ALL of these exist:
 *       an explicit Founder authorization env, a committed bucket allowlist, a
 *       committed run-plan path, AND provisioned read-only credentials. None of
 *       these are provisioned in this build, so --run does nothing but refuse.
 *
 * This entry never creates a token/secret/environment and never dispatches a
 * workflow. It only reads a plan + reads R2 (when fully authorized) + writes an
 * evidence JSON locally.
 */

// Only PURE (no @aws-sdk) modules are imported statically, so --check-authorization
// and --verify-artifact run WITHOUT node_modules installed (the workflow's Founder
// authorization preflight must fail-or-pass BEFORE `npm ci`). The @aws-sdk-backed
// modules (self-test/harness/client-factory) are lazy-imported only inside the
// --self-test / --run paths, which run AFTER install.
import fs from 'fs/promises';
import path from 'path';
import { verifyArtifact } from './verify-artifact.mjs';
import { TEMPLATE_POLICY_PATH } from './template-policy.mjs';
import {
    assertFounderAuthorization,
    AUTHZ_HARNESS_SHA_ENV, AUTHZ_RUN_PLAN_SHA_ENV,
    AUTHZ_TEMPLATE_SHA_ENV, AUTHZ_RUN_PLAN_PATH_ENV,
} from './authorization.mjs';

export const RUN_AUTHZ_ENV = 'RC3B_P0B_RUN_AUTHORIZED';
export const RUN_PLAN_PATH_ENV = 'RC3B_RUN_PLAN_PATH';
export const ALLOWED_BUCKETS_ENV = 'RC3B_ALLOWED_BUCKETS';

// The committed template-policy path is fixed; a real run's authorized plan must
// instantiate it (and its file bytes are anchored by the Founder authorization).
export { TEMPLATE_POLICY_PATH };
// External Founder authorization anchor env var NAMES (referenced, never created).
export {
    AUTHZ_HARNESS_SHA_ENV, AUTHZ_RUN_PLAN_SHA_ENV,
    AUTHZ_TEMPLATE_SHA_ENV, AUTHZ_RUN_PLAN_PATH_ENV,
};

async function doSelfTest() {
    const { runSelfTest } = await import('./self-test.mjs');
    const r = await runSelfTest();
    console.log(`[RC3B-P0B SELF-TEST] ok=${r.ok} checks=${JSON.stringify(r.checks)}`);
    if (!r.ok) { console.error(`[RC3B-P0B SELF-TEST] schema_errors=${JSON.stringify(r.schema_errors)}`); process.exit(1); }
    console.log('[RC3B-P0B SELF-TEST] PASS (offline; no network; no secrets)');
}

function inert(reason) {
    console.error(`[RC3B-P0B] REFUSING --run: ${reason}. The harness is INERT until a dedicated environment, read-only secrets, and a Founder-authorized exact run plan exist.`);
    process.exit(2);
}

async function doRun(env) {
    // (a) existing INERT checks.
    if (env[RUN_AUTHZ_ENV] !== 'true') return inert(`missing explicit authorization (${RUN_AUTHZ_ENV}!=true)`);
    const planPath = env[RUN_PLAN_PATH_ENV];
    if (!planPath) return inert(`no committed run-plan path (${RUN_PLAN_PATH_ENV} unset)`);
    const allowedBuckets = (env[ALLOWED_BUCKETS_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowedBuckets.length) return inert(`no committed bucket allowlist (${ALLOWED_BUCKETS_ENV} unset)`);

    // (b) Founder authorization BEFORE any client construction / network. Fails
    // closed (exit 2) when the external anchors are absent -- as they are here.
    let authz;
    try {
        authz = assertFounderAuthorization(env, { runPlanPath: planPath, templatePolicyPath: TEMPLATE_POLICY_PATH });
    } catch (err) {
        console.error(String(err && err.message ? err.message : err));
        return process.exit(2);
    }

    // (c) THEN construct the read-only client (lazy-loads @aws-sdk-backed modules).
    const { makeMinimalReadOnlyS3Client } = await import('./client-factory.mjs');
    const { loadRunManifest } = await import('./run-manifest.mjs');
    const { runReadOnlyAudit } = await import('./harness.mjs');
    const { buildEvidenceFromRun } = await import('./evidence-assembly.mjs');
    const client = makeMinimalReadOnlyS3Client(env);
    if (!client) return inert('no read-only credentials provisioned');

    // (d) THEN load + run.
    const { plan, rawBytes } = loadRunManifest(planPath);
    const runResult = await runReadOnlyAudit(plan, rawBytes, { allowedBuckets, clientOverride: client });
    const run_metadata = {
        bucket: plan.bucket, r2_endpoint_or_account_id: plan.endpoint_or_account_binding,
        workflow_run_id: env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}` : 'local',
        commit_sha: env.GITHUB_SHA || '', tag_or_ref: env.GITHUB_REF || 'local',
        materialized_run_plan_sha256: plan.materialized_run_plan_sha256,
        template_allowlist_sha256: plan.template_allowlist_sha256,
        materialized_allowlist_sha256: plan.materialized_allowlist_sha256,
        authorized_harness_sha: authz.authorized_harness_sha,
        authorized_run_plan_sha256: authz.authorized_run_plan_sha256,
        authorized_template_sha256: authz.authorized_template_sha256,
        mode: 'READ-ONLY-R2', status: runResult.partial ? 'PARTIAL' : 'RUNTIME-OBSERVED',
    };
    const built = buildEvidenceFromRun(runResult, plan, { run_metadata });
    const outDir = env.RC3B_OUTPUT_DIR || 'output';
    await fs.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, 'rc3b-p0b-readonly-evidence.json');
    await fs.writeFile(out, JSON.stringify(built.evidence, null, 2), 'utf-8');
    console.log(`[RC3B-P0B] evidence written: ${out} schema_valid=${built.schema.valid} leak_pass=${built.scanResult.pass}`);
    if (!built.schema.valid || !built.scanResult.pass) process.exit(1);
}

async function doCheckAuthorization(env) {
    const planPath = env[RUN_PLAN_PATH_ENV];
    try {
        assertFounderAuthorization(env, { runPlanPath: planPath, templatePolicyPath: TEMPLATE_POLICY_PATH });
        console.log('[RC3B-P0B AUTHZ] PASS (external Founder authorization anchors present + bound)');
    } catch (err) {
        console.error(String(err && err.message ? err.message : err));
        return process.exit(2);
    }
}

async function doVerifyArtifact(evidencePath, env) {
    if (!evidencePath) { console.error('[RC3B-P0B VERIFY-ARTIFACT] usage: --verify-artifact <path>'); return process.exit(1); }
    const r = await verifyArtifact(evidencePath, env);
    console.log(`[RC3B-P0B VERIFY-ARTIFACT] ok=${r.ok} checks=${JSON.stringify(r.checks)}`);
    if (!r.ok) { if (r.errors && r.errors.length) console.error(`[RC3B-P0B VERIFY-ARTIFACT] errors=${JSON.stringify(r.errors)}`); process.exit(1); }
}

async function main() {
    const argv = process.argv.slice(2);
    const args = new Set(argv);
    if (args.has('--self-test')) return doSelfTest();
    if (args.has('--check-authorization')) return doCheckAuthorization(process.env);
    if (args.has('--verify-artifact')) return doVerifyArtifact(argv[argv.indexOf('--verify-artifact') + 1], process.env);
    if (args.has('--run')) return doRun(process.env);
    console.log('[RC3B-P0B] usage: run.mjs --self-test | --check-authorization | --verify-artifact <path> | --run   (default: no-op). Build-only; --run is inert without full authorization.');
}

main().catch((err) => { console.error(`[RC3B-P0B] UNHANDLED: ${String(err?.stack ?? err)}`); process.exit(1); });
