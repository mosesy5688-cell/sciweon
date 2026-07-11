/**
 * RC-3B-P0B -- real-artifact post-validation (`--verify-artifact`).
 *
 * Independently re-verifies a produced evidence artifact the way an external
 * auditor would, keeping THREE hash domains strictly separate:
 *   - artifact_sha256        : recompute over the artifact (that field excluded);
 *   - template canonical     : rm.template_allowlist_sha256 === canonical hash;
 *   - authorized file anchor : rm.authorized_template_file_sha256 === the RAW
 *                              committed policy bytes hash (authorized-mode only).
 * The template FILE and CANONICAL hashes are NEVER cross-compared.
 *
 * LOG BUNDLE: when a structural-log path is supplied it READS the file bytes,
 * recomputes sha256 and compares to log_bundle_sha256, and RE-RUNS the leak scan
 * on the actual parsed lines. Without a log path the two log checks are 'SKIPPED'
 * (NOT faked with an empty line array). The artifact-dimension leak rescan uses
 * the granular scanners, so it never depends on logLines.
 *
 * ENDPOINT BINDING: the recorded observed binding must equal the authorized
 * binding with match=PASS; in authorized mode it is additionally re-derived from
 * the actual R2 account id in the environment.
 *
 * OFFLINE mode: when RC3B_P0B_RUN_AUTHORIZED !== 'true' the authorized-anchor
 * checks are 'SKIPPED' (no anchors provisioned in this build); every structural
 * check still runs.
 */

import fs from 'fs';
import { createHash } from 'crypto';
import { loadEvidenceSchema } from './evidence-assembly.mjs';
import { validateDraft07 } from './schema-validate.mjs';
import { recomputeArtifactSha256 } from './evidence-builder.mjs';
import { leakPolicySha256 } from './leak-policy.mjs';
import { scanForbiddenProperties, scanArtifactValues, scanLogs } from './leak-scanner.mjs';
import { parseLogBundle } from './log-bundle.mjs';
import { templatePolicyCanonicalSha256, templatePolicyFileSha256 } from './template-policy.mjs';
import { deriveEndpointBinding, resolveAccountId } from './endpoint-binding.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * @param {string|object} evidenceOrPath  a path to the evidence JSON, or the object
 * @param {object} env  process.env (anchors) -- absent anchors => authorized checks SKIPPED
 * @param {string} [logPath]  the structural-log.jsonl path; when absent, log checks SKIPPED
 * @returns {Promise<{ok:boolean, checks:object, errors:string[]}>}
 */
export async function verifyArtifact(evidenceOrPath, env = process.env, logPath) {
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

    checks.leak_policy_sha256 = ie.leak_policy_sha256 === leakPolicySha256();

    // Artifact-dimension leak rescan via the granular scanners (never logLines).
    const forbidden = scanForbiddenProperties(evidence);
    const values = scanArtifactValues(evidence);
    checks.scan_results_pass = ie.artifact_scan_result === 'PASS'
        && ie.forbidden_property_scan_result === 'PASS'
        && values.result === 'PASS'
        && forbidden.result === 'PASS';

    checks.network_calls_after_stop = oe.network_calls_after_stop === 0;

    // Template CANONICAL (semantic) binding -- its OWN domain, always checked.
    checks.template_policy_canonical_sha256 = rm.template_allowlist_sha256 === templatePolicyCanonicalSha256();

    // Endpoint binding -- observed must equal authorized with match=PASS.
    checks.endpoint_binding_match = rm.endpoint_binding_match === 'PASS'
        && typeof rm.observed_endpoint_or_account_binding === 'string'
        && HEX64.test(rm.observed_endpoint_or_account_binding)
        && rm.observed_endpoint_or_account_binding === rm.authorized_endpoint_or_account_binding;

    // ---- LOG BUNDLE: real file rehash + rescan, or SKIPPED ------------------
    if (logPath) {
        let fileBytes = null;
        try { fileBytes = fs.readFileSync(logPath); } catch { fileBytes = null; }
        if (fileBytes == null) {
            checks.log_bundle_sha256 = false; // MISSING file -> fail (not throw)
            checks.log_scan_result = false;
        } else {
            const fileSha = createHash('sha256').update(fileBytes).digest('hex');
            checks.log_bundle_sha256 = fileSha === ie.log_bundle_sha256;
            const scan = scanLogs(parseLogBundle(fileBytes.toString('utf-8')));
            checks.log_scan_result = ie.log_scan_result === 'PASS' && scan.result === 'PASS';
        }
    } else {
        checks.log_bundle_sha256 = 'SKIPPED';
        checks.log_scan_result = 'SKIPPED';
    }

    // ---- AUTHORIZED-anchor checks (SKIPPED offline) -------------------------
    if (env.RC3B_P0B_RUN_AUTHORIZED !== 'true') {
        checks.authorized_commit_sha = 'SKIPPED';
        checks.authorized_run_plan_sha256 = 'SKIPPED';
        checks.authorized_template_file_sha256 = 'SKIPPED';
        checks.authorized_endpoint_binding = 'SKIPPED';
    } else {
        checks.authorized_commit_sha = rm.commit_sha === env.RC3B_AUTHORIZED_HARNESS_SHA
            && rm.authorized_harness_sha === env.RC3B_AUTHORIZED_HARNESS_SHA;
        checks.authorized_run_plan_sha256 = rm.authorized_run_plan_sha256 === env.RC3B_AUTHORIZED_RUN_PLAN_SHA256;
        // FILE domain: matches the env anchor AND the RAW committed policy bytes.
        checks.authorized_template_file_sha256 = rm.authorized_template_file_sha256 === env.RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256
            && rm.authorized_template_file_sha256 === templatePolicyFileSha256();
        // Re-derive the observed binding from the ACTUAL account id in env.
        const acct = resolveAccountId(env);
        checks.authorized_endpoint_binding = acct != null
            && deriveEndpointBinding(acct) === rm.observed_endpoint_or_account_binding;
    }

    const ok = Object.values(checks).every((v) => v === true || v === 'SKIPPED');
    return { ok, checks, errors };
}
