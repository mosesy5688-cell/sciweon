/**
 * RC-3B-P0B -- ONE shared carrier-input resolver (C1A-R1 / B1). PURE (fs + path).
 *
 * resolveCarrierInputs is the SINGLE place that turns the untrusted env path
 * inputs (RC3B_RUN_PLAN_PATH + RC3B_TEMPLATE_POLICY_PATH) into RESOLVED, real,
 * path-safety-checked absolute paths, anchored to the EXACT trusted checkout
 * root. It is called at the EARLIEST point of every entry path -- the
 * `--check-authorization` CLI preflight (BEFORE any authorization file read),
 * runAuthorizedAudit, and (via resolveCarrierRoot) verify-artifact -- so a
 * traversal / absolute-outside / symlink escape fails with `[RC3B PATH]` BEFORE
 * any authorization file read, client construction, or network.
 *
 * ROOT ANCHORING: in CI the trusted root is GITHUB_WORKSPACE (the exact
 * checkout). An unanchored carrier-root override must NOT expand to '/', a
 * parent, or ANOTHER checkout: when BOTH a workspace and an override are set,
 * the override must resolve INSIDE the workspace, else it is REJECTED.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertSafeCarrierPath } from './path-safety.mjs';
import { TEMPLATE_POLICY_PATH } from './template-policy.mjs';

export const RUN_PLAN_PATH_ENV = 'RC3B_RUN_PLAN_PATH';
export const TEMPLATE_POLICY_PATH_ENV = 'RC3B_TEMPLATE_POLICY_PATH';
export const CARRIER_ROOT_ENV = 'RC3B_CARRIER_ROOT';
export const WORKSPACE_ENV = 'GITHUB_WORKSPACE';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function fail(msg) { throw new Error(`[RC3B PATH] ${msg}`); }

function realDir(dir, label) {
    if (typeof dir !== 'string' || !dir) fail(`${label} is empty or non-string`);
    try { return fs.realpathSync(dir); } catch { return fail(`${label} ${JSON.stringify(dir)} does not exist`); }
}

/**
 * The RESOLVED trusted carrier root. Precedence: GITHUB_WORKSPACE (the exact CI
 * checkout) -> opts.carrierRoot / RC3B_CARRIER_ROOT -> REPO_ROOT. When BOTH a
 * workspace AND an override are set, the override MUST resolve INSIDE the
 * workspace (else REJECTED -- no expansion to '/', a parent, or another checkout).
 *
 * @param {object} env   process.env (or an injected fake in tests)
 * @param {{carrierRoot?:string}} opts
 * @returns {string} the resolved absolute trusted root directory
 * @throws {Error} message begins `[RC3B PATH] `
 */
export function resolveCarrierRoot(env = {}, opts = {}) {
    const workspace = env[WORKSPACE_ENV];
    const override = opts.carrierRoot || env[CARRIER_ROOT_ENV];
    if (workspace) {
        const wsReal = realDir(workspace, WORKSPACE_ENV);
        // An override is only trusted if it stays INSIDE the exact CI checkout;
        // assertSafeCarrierPath returns the resolved in-root path (or throws).
        return override ? assertSafeCarrierPath(override, { rootDir: wsReal }) : wsReal;
    }
    if (override) return realDir(override, 'carrier root');
    return realDir(REPO_ROOT, 'REPO_ROOT');
}

/**
 * IMMUTABLE `{ rootDir, runPlanPath, templatePolicyPath }` with the two carrier
 * paths RESOLVED + path-safety-checked inside rootDir. Throws `[RC3B PATH]` on
 * any traversal / absolute-outside / symlink escape BEFORE returning, so callers
 * that read the plan/policy files always read the RESOLVED, in-root path.
 *
 * @param {object} env   process.env (or an injected fake in tests)
 * @param {{carrierRoot?:string}} opts
 * @returns {Readonly<{rootDir:string, runPlanPath:string, templatePolicyPath:string}>}
 * @throws {Error} message begins `[RC3B PATH] `
 */
export function resolveCarrierInputs(env = {}, opts = {}) {
    const rootDir = resolveCarrierRoot(env, opts);
    const runPlanPath = assertSafeCarrierPath(env[RUN_PLAN_PATH_ENV], { rootDir });
    const templatePolicyPath = assertSafeCarrierPath(
        env[TEMPLATE_POLICY_PATH_ENV] || TEMPLATE_POLICY_PATH, { rootDir },
    );
    return Object.freeze({ rootDir, runPlanPath, templatePolicyPath });
}
