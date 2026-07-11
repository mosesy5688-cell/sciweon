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

import fs from 'fs/promises';
import path from 'path';
import { runSelfTest } from './self-test.mjs';
import { loadRunManifest } from './run-manifest.mjs';
import { runReadOnlyAudit } from './harness.mjs';
import { buildEvidenceFromRun } from './evidence-assembly.mjs';
import { makeMinimalReadOnlyS3Client } from './client-factory.mjs';

export const RUN_AUTHZ_ENV = 'RC3B_P0B_RUN_AUTHORIZED';
export const RUN_PLAN_PATH_ENV = 'RC3B_RUN_PLAN_PATH';
export const ALLOWED_BUCKETS_ENV = 'RC3B_ALLOWED_BUCKETS';

async function doSelfTest() {
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
    if (env[RUN_AUTHZ_ENV] !== 'true') return inert(`missing explicit authorization (${RUN_AUTHZ_ENV}!=true)`);
    const planPath = env[RUN_PLAN_PATH_ENV];
    if (!planPath) return inert(`no committed run-plan path (${RUN_PLAN_PATH_ENV} unset)`);
    const allowedBuckets = (env[ALLOWED_BUCKETS_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowedBuckets.length) return inert(`no committed bucket allowlist (${ALLOWED_BUCKETS_ENV} unset)`);
    const client = makeMinimalReadOnlyS3Client(env);
    if (!client) return inert('no read-only credentials provisioned');

    const { plan, rawBytes } = loadRunManifest(planPath);
    const runResult = await runReadOnlyAudit(plan, rawBytes, { allowedBuckets, clientOverride: client });
    const run_metadata = {
        bucket: plan.bucket, r2_endpoint_or_account_id: plan.endpoint_or_account_binding,
        workflow_run_id: env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}` : 'local',
        commit_sha: env.GITHUB_SHA || '', tag_or_ref: env.GITHUB_REF || 'local',
        materialized_run_plan_sha256: plan.materialized_run_plan_sha256,
        template_allowlist_sha256: plan.template_allowlist_sha256,
        materialized_allowlist_sha256: plan.materialized_allowlist_sha256,
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

async function main() {
    const args = new Set(process.argv.slice(2));
    if (args.has('--self-test')) return doSelfTest();
    if (args.has('--run')) return doRun(process.env);
    console.log('[RC3B-P0B] usage: run.mjs --self-test | --run   (default: no-op). Build-only; --run is inert without full authorization.');
}

main().catch((err) => { console.error(`[RC3B-P0B] UNHANDLED: ${String(err?.stack ?? err)}`); process.exit(1); });
