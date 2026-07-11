/**
 * RC-3B-P0B -- real-artifact post-validation (`--verify-artifact`).
 *
 * Independently re-verifies a produced evidence artifact the way an external
 * auditor would: it recomputes the artifact hash, re-runs the leak scan, checks
 * the committed leak-policy hash, and binds the artifact to the EXTERNAL Founder
 * authorization anchors (commit / run-plan / template SHAs). The --self-test is
 * NOT a substitute for this: self-test proves the harness can build a clean
 * artifact offline; verify-artifact proves a SPECIFIC produced artifact is intact
 * and authorized.
 *
 * OFFLINE mode: when RC3B_P0B_RUN_AUTHORIZED !== 'true' the three authorized-SHA
 * checks are reported as 'SKIPPED' (no anchors provisioned in this build), so the
 * STRUCTURAL checks (schema, artifact hash, leak policy, three PASS scans,
 * network-after-stop) can still be asserted offline.
 */

import fs from 'fs';
import { loadEvidenceSchema } from './evidence-assembly.mjs';
import { validateDraft07 } from './schema-validate.mjs';
import { recomputeArtifactSha256 } from './evidence-builder.mjs';
import { leakPolicySha256 } from './leak-policy.mjs';
import { runLeakScan } from './leak-scanner.mjs';
import { templatePolicySha256 } from './template-policy.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const ZERO64 = '0'.repeat(64);

/**
 * @param {string|object} evidenceOrPath  a path to the evidence JSON, or the object
 * @param {object} env  process.env (anchors) -- absent anchors => SKIPPED offline
 * @returns {Promise<{ok:boolean, checks:object, errors:string[]}>}
 */
export async function verifyArtifact(evidenceOrPath, env = process.env) {
    const errors = [];
    const evidence = typeof evidenceOrPath === 'string'
        ? JSON.parse(fs.readFileSync(evidenceOrPath, 'utf-8'))
        : evidenceOrPath;

    const ie = (evidence && evidence.integrity_evidence) || {};
    const rm = (evidence && evidence.run_metadata) || {};
    const oe = (evidence && evidence.operation_evidence) || {};
    const checks = {};

    // ---- STRUCTURAL checks (always run) -------------------------------------
    const schemaVal = validateDraft07(loadEvidenceSchema(), evidence);
    checks.schema = schemaVal.valid;
    if (!schemaVal.valid) errors.push(...schemaVal.errors);

    checks.artifact_sha256 = recomputeArtifactSha256(evidence) === ie.artifact_sha256;

    checks.log_bundle_sha256 = typeof ie.log_bundle_sha256 === 'string'
        && HEX64.test(ie.log_bundle_sha256) && ie.log_bundle_sha256 !== ZERO64;

    checks.leak_policy_sha256 = ie.leak_policy_sha256 === leakPolicySha256();

    const rescan = runLeakScan({ artifact: evidence, logLines: [] });
    checks.scan_results_pass = ie.artifact_scan_result === 'PASS'
        && ie.log_scan_result === 'PASS'
        && ie.forbidden_property_scan_result === 'PASS'
        && rescan.pass === true;

    checks.network_calls_after_stop = oe.network_calls_after_stop === 0;

    // ---- AUTHORIZED-anchor checks (SKIPPED offline) -------------------------
    if (env.RC3B_P0B_RUN_AUTHORIZED !== 'true') {
        checks.authorized_commit_sha = 'SKIPPED';
        checks.authorized_run_plan_sha256 = 'SKIPPED';
        checks.authorized_template_sha256 = 'SKIPPED';
    } else {
        checks.authorized_commit_sha = rm.commit_sha === env.RC3B_AUTHORIZED_HARNESS_SHA
            && rm.authorized_harness_sha === env.RC3B_AUTHORIZED_HARNESS_SHA;
        checks.authorized_run_plan_sha256 = rm.authorized_run_plan_sha256 === env.RC3B_AUTHORIZED_RUN_PLAN_SHA256;
        checks.authorized_template_sha256 = rm.authorized_template_sha256 === env.RC3B_AUTHORIZED_TEMPLATE_SHA256
            && rm.authorized_template_sha256 === templatePolicySha256();
    }

    const ok = Object.values(checks).every((v) => v === true || v === 'SKIPPED');
    return { ok, checks, errors };
}
