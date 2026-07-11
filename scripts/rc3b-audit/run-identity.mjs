/**
 * RC-3B-P0B -- exact run-identity binding (CHANGE A; A4 + A7 / H4.7).
 *
 * A real READ-ONLY R2 run is bound not only to the Founder authorization anchors
 * (authorization.mjs) but to the EXACT dispatch identity: it must be dispatched
 * from the authorized carrier TAG (never a branch), on the authorized harness
 * commit, at run_attempt==1, under the ONE authorized workflow run id.
 * assertRunIdentity enforces all of them BEFORE any client construction, so an
 * approved carrier can never be re-purposed by a different dispatch. This module
 * is PURE (no fs / no network / no @aws-sdk).
 *
 * run_attempt==1 is NECESSARY but NOT SUFFICIENT: a SECOND independent dispatch
 * also starts at run_attempt==1 -- but it receives a NEW GITHUB_RUN_ID, so the
 * run-id bind below rejects it. Only the single authorized (tag, sha, run-id,
 * attempt-1) dispatch passes.
 */

// The authorized harness SHA anchor env NAME (also checked by authorization.mjs;
// re-asserted here so the identity gate is self-contained).
const AUTHZ_HARNESS_SHA_ENV = 'RC3B_AUTHORIZED_HARNESS_SHA';

export const AUTHZ_CARRIER_TAG_ENV = 'RC3B_AUTHORIZED_CARRIER_TAG';
export const AUTHZ_WORKFLOW_RUN_ID_ENV = 'RC3B_AUTHORIZED_WORKFLOW_RUN_ID';

/**
 * @param {object} env  process.env (or an injected fake in tests)
 * @returns {{carrier_tag:string, workflow_run_id:string, run_attempt:1}}
 * @throws {Error} message begins `[RC3B IDENTITY] ` on ANY failure
 */
export function assertRunIdentity(env) {
    const fail = (msg) => { throw new Error(`[RC3B IDENTITY] ${msg}`); };

    if (env.GITHUB_REF_TYPE !== 'tag') {
        fail(`GITHUB_REF_TYPE ${JSON.stringify(env.GITHUB_REF_TYPE)} != 'tag' -- a real run is dispatched from the authorized carrier TAG, never a branch`);
    }

    const carrierTag = env[AUTHZ_CARRIER_TAG_ENV];
    if (!carrierTag) fail(`${AUTHZ_CARRIER_TAG_ENV} is missing/empty`);
    if (env.GITHUB_REF_NAME !== carrierTag) fail('GITHUB_REF_NAME != authorized carrier tag');

    const harnessSha = env[AUTHZ_HARNESS_SHA_ENV];
    if (!harnessSha) fail(`${AUTHZ_HARNESS_SHA_ENV} is missing/empty`);
    if (env.GITHUB_SHA !== harnessSha) fail('GITHUB_SHA != authorized harness SHA (running code is not the authorized harness)');

    if (String(env.GITHUB_RUN_ATTEMPT) !== '1') {
        fail(`GITHUB_RUN_ATTEMPT ${JSON.stringify(String(env.GITHUB_RUN_ATTEMPT))} != '1' -- a re-run is not authorized; a fresh dispatch is required`);
    }

    const wantRunId = env[AUTHZ_WORKFLOW_RUN_ID_ENV];
    if (!wantRunId) fail(`${AUTHZ_WORKFLOW_RUN_ID_ENV} is missing/empty`);
    if (String(env.GITHUB_RUN_ID) !== wantRunId) {
        fail('GITHUB_RUN_ID != authorized workflow run id -- a SECOND independent dispatch gets a NEW run id and is rejected even at run_attempt==1');
    }

    return { carrier_tag: carrierTag, workflow_run_id: wantRunId, run_attempt: 1 };
}
