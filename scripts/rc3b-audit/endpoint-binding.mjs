/**
 * RC-3B-P0B -- deterministic, non-secret R2 endpoint/account binding (PURE).
 *
 * A Founder-authorized run plan carries `endpoint_or_account_binding`: a 64-hex
 * sha256 of the R2 endpoint URL derived from the AUTHORIZED account id. This
 * module RE-DERIVES that binding from the ACTUAL account id resolved from the
 * environment and asserts it EQUALS the plan's authorized binding BEFORE any
 * S3 client is constructed -- so an approved "account A" plan can never run
 * against "account B" credentials. The binding is a one-way hash of the public
 * endpoint host; the RAW account id is NEVER returned or logged (crypto only).
 */

import { createHash } from 'crypto';

const HEX64 = /^[0-9a-f]{64}$/;

/** Case/space-insensitive account id (endpoint host is case-insensitive). */
export function normalizeAccountId(id) {
    return String(id).trim().toLowerCase();
}

/** sha256 of the derived R2 endpoint URL -- the deterministic, non-secret binding. */
export function deriveEndpointBinding(accountId) {
    const endpoint = `https://${normalizeAccountId(accountId)}.r2.cloudflarestorage.com`;
    return createHash('sha256').update(Buffer.from(endpoint, 'utf-8')).digest('hex');
}

/** SAME account-id resolution order as client-factory (no fabrication). */
export function resolveAccountId(env) {
    return env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || null;
}

/**
 * Assert the ACTUAL derived binding equals the plan's authorized binding. Throws
 * (fail-before-client) on a missing account id, a malformed plan binding, or a
 * mismatch. Returns the three non-secret evidence fields; NEVER the raw id.
 *
 * @param {object} env   process.env (or an injected fake in tests)
 * @param {object} plan  the authorized run plan (carries endpoint_or_account_binding)
 * @returns {{authorized_endpoint_or_account_binding, observed_endpoint_or_account_binding, endpoint_binding_match}}
 */
export function assertEndpointBinding(env, plan) {
    const acct = resolveAccountId(env);
    if (!acct) {
        throw new Error('[RC3B ENDPOINT] MISSING_ACCOUNT_ID: no R2 account id in env (R2_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID / CF_ACCOUNT_ID) -- fail before client');
    }
    const planBinding = plan && plan.endpoint_or_account_binding;
    if (typeof planBinding !== 'string' || !HEX64.test(planBinding)) {
        throw new Error('[RC3B ENDPOINT] MALFORMED_BINDING: plan.endpoint_or_account_binding is not a 64-hex derived binding -- fail before client');
    }
    const observed = deriveEndpointBinding(acct);
    if (observed !== planBinding) {
        throw new Error('[RC3B ENDPOINT] BINDING_MISMATCH: observed != authorized -- fail before client');
    }
    return {
        authorized_endpoint_or_account_binding: planBinding,
        observed_endpoint_or_account_binding: observed,
        endpoint_binding_match: 'PASS',
    };
}
