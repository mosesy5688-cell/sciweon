/**
 * RC-3B-P0B -- external Founder authorization anchors (fail-before-client).
 *
 * A real READ-ONLY R2 run is bound to THREE external, Founder-provisioned anchors
 * that this repo cannot self-satisfy:
 *   - the authorized harness commit SHA (must equal the dispatched GITHUB_SHA),
 *   - the authorized run-plan file-bytes sha256 (over the RAW plan bytes),
 *   - the authorized template-policy file-bytes sha256 (over the RAW policy bytes).
 * assertFounderAuthorization enforces all of them BEFORE any client construction
 * or network. Because no anchors are provisioned in this build, it always throws
 * offline and the harness stays INERT. This module is PURE (fs + crypto only).
 *
 * NOTE: the plan's INTERNAL materialized_run_plan_sha256 stays an integrity check
 * ONLY; it is NEVER the authorization anchor (an attacker who edits the plan can
 * re-seal that internal hash, but cannot forge the EXTERNAL file-bytes anchor).
 */

import fs from 'fs';
import { createHash } from 'crypto';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const RUN_AUTHORIZED_ENV = 'RC3B_P0B_RUN_AUTHORIZED';
export const AUTHZ_HARNESS_SHA_ENV = 'RC3B_AUTHORIZED_HARNESS_SHA';
export const AUTHZ_RUN_PLAN_SHA_ENV = 'RC3B_AUTHORIZED_RUN_PLAN_SHA256';
// The EXTERNAL anchor is the RAW template-policy FILE bytes sha256 (NOT the
// canonical/semantic hash). Named ..._FILE_SHA256 to keep the two hash domains
// non-interchangeable.
export const AUTHZ_TEMPLATE_FILE_SHA_ENV = 'RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256';
export const AUTHZ_RUN_PLAN_PATH_ENV = 'RC3B_AUTHORIZED_RUN_PLAN_PATH';

/** sha256 hex of the RAW file bytes -- the EXTERNAL anchor (not the canonical hash). */
export function sha256OfFileBytes(path) {
    return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

/**
 * @param {object} env   process.env (or an injected fake in tests)
 * @param {{runPlanPath:string, templatePolicyPath:string}} opts
 * @returns {{ok:true, authorized_harness_sha, authorized_run_plan_sha256, authorized_template_file_sha256}}
 * @throws {Error} message begins `[RC3B AUTHZ] MISSING_AUTHORIZATION:` on ANY failure
 */
export function assertFounderAuthorization(env, opts) {
    const fail = (msg) => { throw new Error(`[RC3B AUTHZ] MISSING_AUTHORIZATION: ${msg}`); };

    if (env[RUN_AUTHORIZED_ENV] !== 'true') fail(`${RUN_AUTHORIZED_ENV} != 'true'`);

    const harnessSha = env[AUTHZ_HARNESS_SHA_ENV];
    const runPlanSha = env[AUTHZ_RUN_PLAN_SHA_ENV];
    const templateFileSha = env[AUTHZ_TEMPLATE_FILE_SHA_ENV];
    const authRunPlanPath = env[AUTHZ_RUN_PLAN_PATH_ENV];
    if (!harnessSha) fail(`${AUTHZ_HARNESS_SHA_ENV} is missing/empty`);
    if (!runPlanSha) fail(`${AUTHZ_RUN_PLAN_SHA_ENV} is missing/empty`);
    if (!templateFileSha) fail(`${AUTHZ_TEMPLATE_FILE_SHA_ENV} is missing/empty`);
    if (!authRunPlanPath) fail(`${AUTHZ_RUN_PLAN_PATH_ENV} is missing/empty`);

    if (!HEX40.test(harnessSha)) fail(`${AUTHZ_HARNESS_SHA_ENV} is not a 40-char hex sha`);
    if (!HEX64.test(runPlanSha)) fail(`${AUTHZ_RUN_PLAN_SHA_ENV} is not a 64-char hex sha256`);
    if (!HEX64.test(templateFileSha)) fail(`${AUTHZ_TEMPLATE_FILE_SHA_ENV} is not a 64-char hex sha256`);

    const githubSha = env.GITHUB_SHA;
    if (!githubSha) fail('GITHUB_SHA is absent');
    if (!HEX40.test(githubSha)) fail('GITHUB_SHA is not a 40-char hex sha');
    if (githubSha !== harnessSha) fail('GITHUB_SHA != authorized harness SHA (running code is not the authorized harness)');

    if (opts.runPlanPath !== authRunPlanPath) fail('actual run-plan path != authorized run-plan path');

    const actualRunPlanSha = sha256OfFileBytes(opts.runPlanPath);
    if (actualRunPlanSha !== runPlanSha) fail(`run-plan file-bytes sha256 ${actualRunPlanSha} != authorized ${runPlanSha}`);

    const actualTemplateSha = sha256OfFileBytes(opts.templatePolicyPath);
    if (actualTemplateSha !== templateFileSha) fail(`template-policy file-bytes sha256 ${actualTemplateSha} != authorized ${templateFileSha}`);

    return {
        ok: true,
        authorized_harness_sha: harnessSha,
        authorized_run_plan_sha256: runPlanSha,
        authorized_template_file_sha256: templateFileSha,
    };
}
