/**
 * RC-3B-P0B -- real-artifact post-validation (`--verify-artifact`).
 *
 * Independently re-verifies a produced evidence artifact the way an external
 * auditor would. It keeps THREE hash domains strictly separate:
 *   - artifact_sha256        : recompute over the artifact (that field excluded);
 *   - template canonical     : rm.template_allowlist_sha256 === canonical hash of
 *                              the EXACT template-policy file that was used;
 *   - authorized file anchors : the RAW committed run-plan + policy file-bytes
 *                              hashes (authorized-mode only).
 * The template FILE and CANONICAL hashes are NEVER cross-compared.
 *
 * AUTHORIZED MODE (RC3B_P0B_RUN_AUTHORIZED === 'true') is HARD (CHANGE B):
 *   H4.1  a MISSING structural-log path is a HARD FAIL (never 'SKIPPED').
 *   H4.2  the EXACT run-plan file is re-read + rehashed (path-safe) and compared
 *         to the env anchor + the recorded anchor.
 *   H4.2b the EXACT template-policy file is re-read + rehashed (path-safe) and
 *         compared to the env anchor + the recorded anchor (independent recompute,
 *         never templatePolicyFileSha256() of the committed path only).
 *   H4.3  the log bundle is re-read / rehashed / rescanned (mandatory).
 *   H4.4  NO 'SKIPPED' can yield an authorized PASS: every check must be === true.
 *   H4.5  policy_scope must be 'PRODUCTION-READONLY' (a SYNTHETIC-ONLY policy
 *         makes an authorized PASS impossible).
 * OFFLINE MODE keeps the SKIPPED-tolerant roll-up and SKIPPED authorized anchors.
 *
 * Every carrier-file read is path-safety-gated (CHANGE E) BEFORE the read.
 */

import fs from 'fs';
import { createHash } from 'crypto';
import { loadEvidenceSchema } from './evidence-assembly.mjs';
import { validateDraft07 } from './schema-validate.mjs';
import { recomputeArtifactSha256 } from './evidence-builder.mjs';
import { leakPolicySha256 } from './leak-policy.mjs';
import { scanForbiddenProperties, scanArtifactValues, scanLogs } from './leak-scanner.mjs';
import { parseLogBundle } from './log-bundle.mjs';
import { templatePolicyCanonicalSha256 } from './template-policy.mjs';
import { deriveEndpointBinding, resolveAccountId } from './endpoint-binding.mjs';
import { assertSafeCarrierPath } from './path-safety.mjs';
import { resolveCarrierRoot } from './carrier-inputs.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Read a carrier file's bytes ONLY through a path-safety gate; null on any
 * failure. C1A-R1 / B1: read the RESOLVED, in-root path returned by
 * assertSafeCarrierPath -- NOT the original unresolved `p` -- so the path that is
 * safety-checked is the exact path whose bytes are hashed (a symlinked `p` cannot
 * pass the check yet be re-read to different bytes).
 */
function safeFileBytes(p, rootDir) {
    if (typeof p !== 'string' || !p) return null;
    let resolved;
    try { resolved = assertSafeCarrierPath(p, { rootDir }); } catch { return null; }
    try { return fs.readFileSync(resolved); } catch { return null; }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/**
 * @param {string|object} evidenceOrPath  a path to the evidence JSON, or the object
 * @param {object} env  process.env (anchors) -- absent anchors => authorized checks SKIPPED
 * @param {string} [logPath]  the structural-log.jsonl path
 * @param {string} [runPlanPath]  the EXACT run-plan file (authorized-mode rehash)
 * @param {string} [templatePolicyPath]  the EXACT template-policy file (authorized-mode rehash)
 * @returns {Promise<{ok:boolean, checks:object, errors:string[]}>}
 */
export async function verifyArtifact(evidenceOrPath, env = process.env, logPath, runPlanPath, templatePolicyPath) {
    const errors = [];
    const evidence = typeof evidenceOrPath === 'string'
        ? JSON.parse(fs.readFileSync(evidenceOrPath, 'utf-8'))
        : evidenceOrPath;

    const authorized = env.RC3B_P0B_RUN_AUTHORIZED === 'true';
    // C1A-R1 / B1: the trusted root is anchored the SAME way as the resolver
    // (GITHUB_WORKSPACE in CI; an unanchored override cannot expand to '/', a
    // parent, or another checkout).
    const rootDir = resolveCarrierRoot(env);

    const ie = (evidence && evidence.integrity_evidence) || {};
    const rm = (evidence && evidence.run_metadata) || {};
    const oe = (evidence && evidence.operation_evidence) || {};
    const checks = {};

    // In authorized mode, re-read the EXACT template-policy file ONCE (path-safe).
    const tpBytes = authorized ? safeFileBytes(templatePolicyPath, rootDir) : null;
    let tpParsed = null;
    if (tpBytes != null) { try { tpParsed = JSON.parse(tpBytes.toString('utf-8')); } catch { tpParsed = null; } }

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

    // Template CANONICAL (semantic) binding. Authorized mode recomputes it from
    // the EXACT policy file that was used; offline from the committed policy.
    checks.template_policy_canonical_sha256 = (authorized && tpParsed)
        ? rm.template_allowlist_sha256 === templatePolicyCanonicalSha256(tpParsed)
        : (authorized
            ? false // authorized but the policy file is missing/unsafe/unparseable
            : rm.template_allowlist_sha256 === templatePolicyCanonicalSha256());

    // Endpoint binding -- observed must equal authorized with match=PASS.
    checks.endpoint_binding_match = rm.endpoint_binding_match === 'PASS'
        && typeof rm.observed_endpoint_or_account_binding === 'string'
        && HEX64.test(rm.observed_endpoint_or_account_binding)
        && rm.observed_endpoint_or_account_binding === rm.authorized_endpoint_or_account_binding;

    // CHANGE C: the endpoint evidence is the normalized 64-hex binding == observed
    // == authorized (a raw account id / URL cannot occupy this field).
    checks.endpoint_evidence = typeof rm.r2_endpoint_or_account_binding === 'string'
        && HEX64.test(rm.r2_endpoint_or_account_binding)
        && rm.r2_endpoint_or_account_binding === rm.observed_endpoint_or_account_binding
        && rm.r2_endpoint_or_account_binding === rm.authorized_endpoint_or_account_binding
        && rm.endpoint_binding_match === 'PASS';

    // ---- LOG BUNDLE: real file rehash + rescan, or SKIPPED/HARD-FAIL ---------
    if (logPath) {
        let fileBytes = null;
        try { fileBytes = fs.readFileSync(logPath); } catch { fileBytes = null; }
        if (fileBytes == null) {
            checks.log_bundle_sha256 = false; // MISSING file -> fail (not throw)
            checks.log_scan_result = false;
        } else {
            checks.log_bundle_sha256 = sha256(fileBytes) === ie.log_bundle_sha256;
            const scan = scanLogs(parseLogBundle(fileBytes.toString('utf-8')));
            checks.log_scan_result = ie.log_scan_result === 'PASS' && scan.result === 'PASS';
        }
    } else if (authorized) {
        // H4.1: a MISSING structural-log path is a HARD FAIL in authorized mode.
        checks.log_bundle_sha256 = false;
        checks.log_scan_result = false;
    } else {
        checks.log_bundle_sha256 = 'SKIPPED';
        checks.log_scan_result = 'SKIPPED';
    }

    // ---- AUTHORIZED-anchor checks (SKIPPED offline; HARD otherwise) ----------
    if (!authorized) {
        checks.authorized_commit_sha = 'SKIPPED';
        checks.authorized_run_plan_sha256 = 'SKIPPED';
        checks.authorized_template_file_sha256 = 'SKIPPED';
        checks.authorized_policy_scope = 'SKIPPED';
        checks.authorized_endpoint_binding = 'SKIPPED';
        // C1A-R1 / B4: INDEPENDENT run-identity re-verification is SKIPPED offline.
        checks.authorized_carrier_tag = 'SKIPPED';
        checks.authorized_workflow_run_id = 'SKIPPED';
        checks.authorized_workflow_run_attempt = 'SKIPPED';
        checks.authorized_tag_ref = 'SKIPPED';
    } else {
        checks.authorized_commit_sha = rm.commit_sha === env.RC3B_AUTHORIZED_HARNESS_SHA
            && rm.authorized_harness_sha === env.RC3B_AUTHORIZED_HARNESS_SHA;

        // H4.2: re-read + rehash the EXACT run-plan FILE (path-safe).
        const rpBytes = safeFileBytes(runPlanPath, rootDir);
        const rpSha = rpBytes != null ? sha256(rpBytes) : null;
        checks.authorized_run_plan_sha256 = rpSha != null
            && rpSha === env.RC3B_AUTHORIZED_RUN_PLAN_SHA256
            && rm.authorized_run_plan_sha256 === env.RC3B_AUTHORIZED_RUN_PLAN_SHA256;

        // H4.2b: re-read + rehash the EXACT template-policy FILE (path-safe).
        const tpSha = tpBytes != null ? sha256(tpBytes) : null;
        checks.authorized_template_file_sha256 = tpSha != null
            && tpSha === env.RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256
            && rm.authorized_template_file_sha256 === env.RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256;

        // H4.5: policy_scope gate -- an authorized PASS requires PRODUCTION-READONLY.
        checks.authorized_policy_scope = !!tpParsed && tpParsed.policy_scope === 'PRODUCTION-READONLY';

        // Re-derive the observed binding from the ACTUAL account id in env.
        const acct = resolveAccountId(env);
        checks.authorized_endpoint_binding = acct != null
            && deriveEndpointBinding(acct) === rm.observed_endpoint_or_account_binding;

        // C1A-R1 / B4: INDEPENDENT run-identity re-verification -- the evidence's
        // recorded identity must agree with BOTH the authorized anchors AND the
        // GitHub-provided dispatch context (not just the pre-network gate).
        checks.authorized_carrier_tag = rm.carrier_tag === env.RC3B_AUTHORIZED_CARRIER_TAG
            && rm.carrier_tag === env.GITHUB_REF_NAME;
        checks.authorized_workflow_run_id = String(rm.workflow_run_id) === String(env.GITHUB_RUN_ID)
            && /^[0-9]+$/.test(String(rm.workflow_run_id));
        checks.authorized_workflow_run_attempt = rm.workflow_run_attempt === 1
            && String(env.GITHUB_RUN_ATTEMPT) === '1';
        checks.authorized_tag_ref = rm.tag_or_ref === env.GITHUB_REF
            && env.GITHUB_REF_TYPE === 'tag'
            && env.GITHUB_REF_NAME === env.RC3B_AUTHORIZED_CARRIER_TAG;
    }

    // H4.4: authorized mode requires EVERY check === true (any 'SKIPPED' or false
    // fails). Offline keeps the SKIPPED-tolerant roll-up.
    const ok = authorized
        ? Object.values(checks).every((v) => v === true)
        : Object.values(checks).every((v) => v === true || v === 'SKIPPED');
    return { ok, checks, errors };
}
