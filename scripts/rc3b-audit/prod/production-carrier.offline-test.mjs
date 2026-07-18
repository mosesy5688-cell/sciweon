/**
 * RC-3B-P0B-C4-A -- OFFLINE production-carrier proof (ZERO network, ZERO real values).
 *
 * Proves, entirely offline, that the two committed production-carrier files
 * (scripts/rc3b-audit/prod/production-template-policy.json + production-run-spec.json)
 * are BYTE-IDENTICAL to the founder-frozen governance sources (raw sha256 anchors),
 * are accepted BY THE LANDED canonicalizers + run-manifest validator, carry a
 * consistent non-secret endpoint binding, describe exactly the 5x (HEAD + GET_LOCATOR)
 * read-only shape with the four non-locator arrays empty and the LIST/GET_META/RANGE
 * caps pinned to 0, and that the C4-A/B5 pre-client scope gate accepts this
 * PRODUCTION-READONLY policy while a SYNTHETIC-ONLY / missing / null / unknown scope
 * fails BEFORE any client (source-order proves the gate precedes client construction,
 * so client-construction count stays 0). It also proves the C4-A/B2 client endpoint is
 * built under the SAME normalization the binding uses (positive + negative controls).
 *
 * It also proves the C4-E-T1 session-token model: the minimal read-only client
 * constructs ONLY with a format-valid temporary R2 session token (a synthetic
 * fake), the token is byte-exact in the client's resolved credentials, and a
 * 3-field-only trio (no token) or a malformed token BOTH throw before any client.
 *
 * No secret, no environment, no production R2, no real account id / endpoint / token is
 * used or emitted: the only account id here is a synthetic fake, the only session token
 * is a synthetic format-valid fake, and the caps prove no network is reachable.
 * Run: node scripts/rc3b-audit/prod/production-carrier.offline-test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { runPlanSha256, allowlistSha256 } from '../manifest-hash.mjs';
import { templatePolicyCanonicalSha256 } from '../template-policy.mjs';
import { validateRunManifest } from '../run-manifest.mjs';
import { resolveCaps } from '../caps.mjs';
import { normalizeAccountId, deriveEndpointBinding } from '../endpoint-binding.mjs';
import { makeMinimalReadOnlyS3Client } from '../client-factory.mjs';
import { assertProductionPolicyScope } from '../authorized-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POLICY_PATH = path.join(HERE, 'production-template-policy.json');
export const RUN_PLAN_PATH = path.join(HERE, 'production-run-spec.json');
const AUTHORIZED_RUN_SRC = path.join(HERE, '..', 'authorized-run.mjs');

// Founder-frozen anchors. The local-only governance SOURCE files are deliberately
// NOT in the repo, so the anchors are pinned here and checked against the committed
// carrier bytes (raw sha256) + the canonicalizer/validator outputs.
export const FROZEN = Object.freeze({
    policyFileSha256: '5831fae245cb56e2bb48d11e711843b83d1191980ed3f920fcc3287c4fe07586',
    runPlanFileSha256: 'b1f8485637702b70fae2ddbd1f908bb46f2f620752e48881632ccd1f94eb2c54',
    templateAllowlistSha256: 'bf3408c18e3bbbe9ac97031559238cc364d755dc0b9f98a9f094ac2f2e285647',
    materializedAllowlistSha256: '92d911d5830121d17b3d2f7af342ea6aa35e89e3a6efe24d4b9624b65b62e77c',
    materializedRunPlanSha256: 'dc70b5bd13aa701c3b2b82b43bd42536da14fc4d5cd202d11d561e030f4ed5bf',
    endpointBinding: 'ad70e9363f0db353eced534bbe4a4e5104b6378257250e8c9117c4b427eaf85e',
    bucket: 'sciweon-prod',
});

const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sha256Str = (s) => createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

// C4-E-T1: a synthetic, format-VALID temporary R2 session token
// (base64("jwt/" + three-segment JWT)). It is a FAKE -- NOT a real/signed token;
// the client's session-token gate is FORMAT-only (no signer, no claim parsing).
const SYNTH_SESSION_TOKEN = Buffer.from('jwt/aaa.bbb.ccc').toString('base64');

export function loadCarriers() {
    const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf-8'));
    const plan = JSON.parse(fs.readFileSync(RUN_PLAN_PATH, 'utf-8'));
    return { policy, plan };
}

/** The four scope-gate negatives: synthetic / missing / null / unknown ALL throw. */
export function scopeGateNegatives() {
    return {
        synthetic: threw(() => assertProductionPolicyScope({ policy_scope: 'SYNTHETIC-ONLY' })),
        missing: threw(() => assertProductionPolicyScope({})),
        null_scope: threw(() => assertProductionPolicyScope({ policy_scope: null })),
        unknown: threw(() => assertProductionPolicyScope({ policy_scope: 'SOME-UNKNOWN-SCOPE' })),
    };
}

/** C4-A / B2: the client endpoint uses the SAME normalization the binding uses.
 *  C4-E-T1: the client now REQUIRES a temporary R2 session token (no fallback to
 *  a 3-field-only credential), so pass a synthetic format-valid token so it builds;
 *  also prove the token is byte-exact in the credentials and that a no-token /
 *  malformed-token trio BOTH throw before any client. All offline: no network. */
export async function b2Normalization() {
    const messy = '  R2acct-XYZ  '; // synthetic fake: whitespace + uppercase, no real value
    const norm = normalizeAccountId(messy); // 'r2acct-xyz'
    const trio = {
        R2_ACCOUNT_ID: messy, R2_ACCESS_KEY_ID: 'ro-fake-key', R2_SECRET_ACCESS_KEY: 'ro-fake-secret',
    };
    // Trio + a synthetic format-valid session token -> the client constructs.
    const client = makeMinimalReadOnlyS3Client({ ...trio, R2_SESSION_TOKEN: SYNTH_SESSION_TOKEN });
    const ep = await client.config.endpoint(); // local resolver -- NO network
    const normalizedHost = `${norm}.r2.cloudflarestorage.com`;
    const rawHost = `${messy}.r2.cloudflarestorage.com`;
    const bindingEndpoint = `https://${norm}.r2.cloudflarestorage.com`;
    // POSITIVE: the client host is the NORMALIZED host, and it is byte-for-byte the
    // host whose sha256 deriveEndpointBinding (assertEndpointBinding) verifies.
    const positive = ep.hostname === normalizedHost
        && deriveEndpointBinding(messy) === sha256Str(bindingEndpoint)
        && ep.hostname === bindingEndpoint.slice('https://'.length);
    // NEGATIVE: normalization is meaningful for this id and the client did NOT use
    // the raw (un-normalized) account id.
    const negative = norm !== messy && ep.hostname !== rawHost;
    // C4-E-T1: the client was built, the session token is byte-exact in its resolved
    // credentials, and the no-fallback gate holds -- a 3-field-only trio (no token)
    // AND a malformed token BOTH throw before any client (local resolver -- NO network).
    const clientConstructed = !!client;
    const sessionTokenByteExact = (await client.config.credentials()).sessionToken === SYNTH_SESSION_TOKEN;
    const noTokenFails = threw(() => makeMinimalReadOnlyS3Client({ ...trio }));
    const malformedTokenFails = threw(() => makeMinimalReadOnlyS3Client({ ...trio, R2_SESSION_TOKEN: 'notbase64$$$' }));
    return {
        positive, negative, normalizedHost, host: ep.hostname,
        clientConstructed, sessionTokenByteExact, noTokenFails, malformedTokenFails,
    };
}

export async function runProductionCarrierOfflineTest() {
    const checks = {};
    const { policy, plan } = loadCarriers();

    // 1. BYTE-IDENTICAL: committed carrier bytes hash to the frozen anchors.
    checks.policy_file_sha256 = sha256File(POLICY_PATH) === FROZEN.policyFileSha256;
    checks.run_plan_file_sha256 = sha256File(RUN_PLAN_PATH) === FROZEN.runPlanFileSha256;

    // 2. Accepted by the LANDED canonicalizers + validator.
    checks.policy_scope_production = policy.policy_scope === 'PRODUCTION-READONLY';
    checks.template_canonical_hash = templatePolicyCanonicalSha256(policy) === FROZEN.templateAllowlistSha256
        && plan.template_allowlist_sha256 === FROZEN.templateAllowlistSha256;
    checks.materialized_allowlist_hash = allowlistSha256(plan) === FROZEN.materializedAllowlistSha256
        && plan.materialized_allowlist_sha256 === FROZEN.materializedAllowlistSha256;
    checks.materialized_run_plan_hash = runPlanSha256(plan) === FROZEN.materializedRunPlanSha256
        && plan.materialized_run_plan_sha256 === FROZEN.materializedRunPlanSha256;
    const v = validateRunManifest(plan, { allowedBuckets: [FROZEN.bucket], templatePolicy: policy });
    checks.validator_admissible = v.admissible === true;
    if (!v.admissible) checks._validator_errors = v.errors;

    // 3. Endpoint binding consistency (non-secret 64-hex; allowlisted; bucket bound).
    checks.endpoint_binding_wellformed = /^[0-9a-f]{64}$/.test(plan.endpoint_or_account_binding)
        && plan.endpoint_or_account_binding === FROZEN.endpointBinding;
    checks.endpoint_binding_allowlisted = Array.isArray(policy.endpoint_or_account_binding_allowlist)
        && policy.endpoint_or_account_binding_allowlist.length === 1
        && policy.endpoint_or_account_binding_allowlist[0] === plan.endpoint_or_account_binding;
    checks.bucket_bound = plan.bucket === FROZEN.bucket
        && Array.isArray(policy.bucket_allowlist) && policy.bucket_allowlist.length === 1
        && policy.bucket_allowlist[0] === FROZEN.bucket;

    // 4. Read-only shape: exactly 5 unique locator keys; 5 GET_LOCATOR families; the
    //    four non-locator arrays empty; STRUCTURAL_JSON only.
    const specKeys = new Set((plan.structural_locator_specs || []).map((s) => s.key));
    const familyKeys = new Set((policy.families || []).filter((f) => f.operation === 'GET_LOCATOR').map((f) => f.exact_key));
    const mapKeys = Object.keys(plan.object_class_map || {});
    checks.five_unique_locator_keys = specKeys.size === 5 && familyKeys.size === 5 && mapKeys.length === 5;
    checks.locator_keys_agree = [...specKeys].every((k) => familyKeys.has(k)) && mapKeys.every((k) => familyKeys.has(k));
    const getLocatorFamilies = (policy.families || []).filter((f) => f.operation === 'GET_LOCATOR');
    checks.five_get_locator_families = getLocatorFamilies.length === 5
        && getLocatorFamilies.every((f) => f.object_class === 'STRUCTURAL_JSON');
    checks.all_structural_json = mapKeys.every((k) => plan.object_class_map[k] === 'STRUCTURAL_JSON')
        && Array.isArray(plan.allowed_object_classes) && plan.allowed_object_classes.length === 1
        && plan.allowed_object_classes[0] === 'STRUCTURAL_JSON';
    checks.empty_non_locator_arrays = ['exact_prefixes', 'structural_keys', 'class_c_head_keys', 'class_x_targets']
        .every((f) => Array.isArray(plan[f]) && plan[f].length === 0);

    // 5. Caps: LIST / GET_META / RANGE == 0; HEAD / GET_LOCATOR / OBJECTS == 5 (raw
    //    AND after resolveCaps clamps against the immutable ceilings).
    const rawCaps = plan.caps || {};
    const caps = resolveCaps(rawCaps);
    checks.caps_zero = rawCaps.MAX_LIST_KEYS_PER_RUN === 0 && rawCaps.MAX_LIST_PAGES_PER_RUN === 0
        && rawCaps.MAX_GET_META_REQUESTS_PER_RUN === 0 && rawCaps.MAX_RANGE_REQUESTS_PER_RUN === 0
        && caps.MAX_LIST_KEYS_PER_RUN === 0 && caps.MAX_LIST_PAGES_PER_RUN === 0
        && caps.MAX_GET_META_REQUESTS_PER_RUN === 0 && caps.MAX_RANGE_REQUESTS_PER_RUN === 0;
    checks.caps_five = rawCaps.MAX_HEAD_REQUESTS_PER_RUN === 5 && rawCaps.MAX_GET_LOCATOR_REQUESTS_PER_RUN === 5
        && rawCaps.MAX_OBJECTS_TOUCHED_PER_RUN === 5
        && caps.MAX_HEAD_REQUESTS_PER_RUN === 5 && caps.MAX_GET_LOCATOR_REQUESTS_PER_RUN === 5
        && caps.MAX_OBJECTS_TOUCHED_PER_RUN === 5;

    // 6. C4-A / B5 pre-client scope gate: positive + the four negatives + source-order
    //    proof that the gate runs BEFORE endpoint binding + client construction, so a
    //    non-production scope fails with client-construction count 0 / network 0.
    checks.scope_gate_positive = assertProductionPolicyScope(policy) === true;
    const neg = scopeGateNegatives();
    checks.scope_gate_negatives = neg.synthetic && neg.missing && neg.null_scope && neg.unknown;
    const src = fs.readFileSync(AUTHORIZED_RUN_SRC, 'utf-8');
    const gateAt = src.indexOf('assertProductionPolicyScope(templatePolicy)');
    const bindAt = src.indexOf('assertEndpointBinding(env, plan)');
    const clientAt = src.indexOf('makeMinimalReadOnlyS3Client(env)');
    checks.scope_gate_before_client = gateAt > 0 && bindAt > gateAt && clientAt > gateAt;

    // 7. C4-A / B2 client-endpoint normalization (positive + negative controls) +
    //    C4-E-T1 session-token model: the client builds ONLY with a format-valid
    //    temporary session token, the token is byte-exact in the client's resolved
    //    credentials, and a 3-field-only trio (no token) or a malformed token BOTH
    //    throw before any client (client-construction count 0 on the failure paths).
    const b2 = await b2Normalization();
    checks.b2_normalization_positive = b2.positive;
    checks.b2_normalization_negative = b2.negative;
    checks.b2_client_constructed = b2.clientConstructed;
    checks.b2_session_token_byte_exact = b2.sessionTokenByteExact;
    checks.b2_no_token_fails = b2.noTokenFails;
    checks.b2_malformed_token_fails = b2.malformedTokenFails;

    const ok = Object.entries(checks).every(([k, val]) => k.startsWith('_') || val === true);
    return { ok, checks };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    runProductionCarrierOfflineTest().then((r) => {
        for (const [k, val] of Object.entries(r.checks)) {
            if (k.startsWith('_')) { console.log(`   info ${k}=${JSON.stringify(val)}`); continue; }
            console.log(`[${val === true ? 'PASS' : 'FAIL'}] ${k}`);
        }
        console.log(`[RC3B-P0B-C4-A PROD-CARRIER OFFLINE] ok=${r.ok} (no network; no secrets; no real values)`);
        process.exit(r.ok ? 0 : 1);
    }).catch((e) => {
        console.error(`[RC3B-P0B-C4-A PROD-CARRIER OFFLINE] UNHANDLED: ${e && e.stack ? e.stack : e}`);
        process.exit(1);
    });
}
