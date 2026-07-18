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
import { verifyArtifact } from './verify-artifact.mjs';
import { TEMPLATE_POLICY_PATH } from './template-policy.mjs';
import {
    assertFounderAuthorization,
    AUTHZ_HARNESS_SHA_ENV, AUTHZ_RUN_PLAN_SHA_ENV,
    AUTHZ_TEMPLATE_FILE_SHA_ENV, AUTHZ_RUN_PLAN_PATH_ENV, AUTHZ_TEMPLATE_PATH_ENV,
} from './authorization.mjs';
import { assertRunIdentity } from './run-identity.mjs';
import { resolveCarrierInputs } from './carrier-inputs.mjs';
import { assertValidSessionToken } from './session-token.mjs';

export const RUN_AUTHZ_ENV = 'RC3B_P0B_RUN_AUTHORIZED';
export const RUN_PLAN_PATH_ENV = 'RC3B_RUN_PLAN_PATH';
export const ALLOWED_BUCKETS_ENV = 'RC3B_ALLOWED_BUCKETS';

// The committed template-policy path is fixed; a real run's authorized plan must
// instantiate it (and its file bytes are anchored by the Founder authorization).
export { TEMPLATE_POLICY_PATH };
// External Founder authorization anchor env var NAMES (referenced, never created).
export {
    AUTHZ_HARNESS_SHA_ENV, AUTHZ_RUN_PLAN_SHA_ENV,
    AUTHZ_TEMPLATE_FILE_SHA_ENV, AUTHZ_RUN_PLAN_PATH_ENV, AUTHZ_TEMPLATE_PATH_ENV,
};

async function doSelfTest() {
    const { runSelfTest, runLocatorSelfTest } = await import('./self-test.mjs');
    const r = await runSelfTest();
    const locator = await runLocatorSelfTest();
    console.log(`[RC3B-P0B SELF-TEST] ok=${r.ok} checks=${JSON.stringify(r.checks)}`);
    console.log(`[RC3B-P0B LOCATOR SELF-TEST] ok=${locator.ok} checks=${JSON.stringify(locator.checks)}`);
    if (!r.ok || !locator.ok) { console.error(`[RC3B-P0B SELF-TEST] schema_errors=${JSON.stringify(r.schema_errors)}`); process.exit(1); }
    console.log('[RC3B-P0B SELF-TEST] PASS (offline; no network; no secrets)');
}

function inert(reason) {
    console.error(`[RC3B-P0B] REFUSING --run: ${reason}. The harness is INERT until a dedicated environment, read-only secrets, and a Founder-authorized exact run plan exist.`);
    process.exit(2);
}

async function doRun(env) {
    // (a) pre-authz INERT checks (no @aws-sdk / no network; keep install-free).
    if (env[RUN_AUTHZ_ENV] !== 'true') return inert(`missing explicit authorization (${RUN_AUTHZ_ENV}!=true)`);
    const planPath = env[RUN_PLAN_PATH_ENV];
    if (!planPath) return inert(`no committed run-plan path (${RUN_PLAN_PATH_ENV} unset)`);
    const allowedBuckets = (env[ALLOWED_BUCKETS_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowedBuckets.length) return inert(`no committed bucket allowlist (${ALLOWED_BUCKETS_ENV} unset)`);

    // (b) lazy-import the authorized-mode flow (pulls @aws-sdk-backed deps) only
    // AFTER npm ci. It performs, in order: external raw-file authorization anchors
    // -> load plan -> validate -> derive+assert endpoint binding -> construct
    // client -> network -> write evidence + structural log. Any anchor/binding
    // failure THROWS before the client -> exit 2 (inert), as in this build.
    const { runAuthorizedAudit } = await import('./authorized-run.mjs');
    let result;
    try {
        result = await runAuthorizedAudit(env, {});
    } catch (err) {
        console.error(String(err && err.message ? err.message : err));
        return process.exit(2);
    }
    if (result.inert) return inert(result.reason);
    console.log(`[RC3B-P0B] evidence written: ${result.evidencePath} log: ${result.logPath} locators: ${result.locatorArtifactPath} schema_valid=${result.schema.valid} leak_pass=${result.scanResult.pass}`);
    if (!result.schema.valid || !result.scanResult.pass || !result.locatorSchema.valid || !result.locatorScanResult.pass) process.exit(1);
}

async function doCheckAuthorization(env) {
    try {
        // C1A-R1 / B1: PATH-SAFETY FIRST, via the ONE shared resolver, BEFORE any
        // authorization file (plan/template) is read. A traversal / absolute-outside
        // / symlink-escape run-plan or template path fails with `[RC3B PATH]` here,
        // before npm ci and before any anchor hash is read.
        const resolved = resolveCarrierInputs(env);
        // THEN the external Founder authorization anchors + the EXACT authorized
        // run-plan/template PATH anchors, on the RESOLVED paths only.
        assertFounderAuthorization(env, {
            runPlanPath: resolved.runPlanPath,
            templatePolicyPath: resolved.templatePolicyPath,
            rootDir: resolved.rootDir,
        });
        // C4-E-T2 F2 (identity-before-secret): FIRST bind the EXACT run identity, so a
        // wrong tag / ref / attempt / run-id fails on IDENTITY BEFORE npm ci
        // (fail-before-install) and BEFORE any session token is decoded.
        assertRunIdentity(env);
        // C4-E-T1: THEN REQUIRE a valid temporary R2 session token in the SAME preflight
        // (still before install/client/network), so a missing/invalid token fails here
        // (fixed, leak-free code) with NO fallback to a long-term 3-field credential.
        // This is the SAME gate makeMinimalReadOnlyS3Client enforces, hoisted into the
        // install-free preflight (pure; no @aws-sdk).
        assertValidSessionToken(env);
        console.log('[RC3B-P0B AUTHZ] PASS (path-safe carrier inputs + external Founder authorization anchors + exact run identity + temporary session token bound)');
    } catch (err) {
        console.error(String(err && err.message ? err.message : err));
        return process.exit(2);
    }
}

async function doVerifyArtifact(evidencePath, logPath, runPlanPath, templatePolicyPath, locatorArtifactPath, env) {
    if (!evidencePath) { console.error('[RC3B-P0B VERIFY-ARTIFACT] usage: --verify-artifact <evidence.json> [structural-log.jsonl] [run-plan.json] [template-policy.json] [resolved-locators.json]'); return process.exit(1); }
    const r = await verifyArtifact(evidencePath, env, logPath, runPlanPath, templatePolicyPath, locatorArtifactPath);
    console.log(`[RC3B-P0B VERIFY-ARTIFACT] ok=${r.ok} checks=${JSON.stringify(r.checks)}`);
    if (!r.ok) { if (r.errors && r.errors.length) console.error(`[RC3B-P0B VERIFY-ARTIFACT] errors=${JSON.stringify(r.errors)}`); process.exit(1); }
}

async function main() {
    const argv = process.argv.slice(2);
    const args = new Set(argv);
    if (args.has('--self-test')) return doSelfTest();
    if (args.has('--check-authorization')) return doCheckAuthorization(process.env);
    if (args.has('--verify-artifact')) {
        const i = argv.indexOf('--verify-artifact');
        const pos = (n) => (argv[i + n] && !argv[i + n].startsWith('--') ? argv[i + n] : undefined);
        return doVerifyArtifact(pos(1), pos(2), pos(3), pos(4), pos(5), process.env);
    }
    if (args.has('--run')) return doRun(process.env);
    console.log('[RC3B-P0B] usage: run.mjs --self-test | --check-authorization | --verify-artifact <evidence.json> [structural-log.jsonl] [run-plan.json] [template-policy.json] [resolved-locators.json] | --run   (default: no-op). Build-only; --run is inert without full authorization.');
}

main().catch((err) => { console.error(`[RC3B-P0B] UNHANDLED: ${String(err?.stack ?? err)}`); process.exit(1); });
