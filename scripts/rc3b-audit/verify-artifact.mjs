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
import { scanForbiddenProperties, scanArtifactValues, scanLogs, scanLocatorArtifact } from './leak-scanner.mjs';
import { parseLogBundle } from './log-bundle.mjs';
import { templatePolicyCanonicalSha256, loadTemplatePolicy } from './template-policy.mjs';
import { deriveEndpointBinding, resolveAccountId } from './endpoint-binding.mjs';
import { assertSafeCarrierPath } from './path-safety.mjs';
import { resolveCarrierRoot } from './carrier-inputs.mjs';
import { canonicalScalarBytes, LOCATOR_PATTERNS, evaluateCrossFieldTwoPhase } from './locator-extract.mjs';
import { loadLocatorArtifactSchema, locatorSpecSetSha256, recomputeLocatorArtifactSha256 } from './locator-artifact.mjs';
import { validateRunManifest } from './run-manifest.mjs';

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
function readJson(value) { return typeof value === 'string' ? JSON.parse(fs.readFileSync(value, 'utf-8')) : value; }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function expectedIdentity(rm) {
    return {
        bucket: rm.bucket, r2_endpoint_or_account_binding: rm.r2_endpoint_or_account_binding,
        carrier_tag: rm.carrier_tag, workflow_run_id: String(rm.workflow_run_id),
        workflow_run_attempt: rm.workflow_run_attempt, commit_sha: rm.commit_sha,
        tag_or_ref: rm.tag_or_ref, mode: rm.mode,
    };
}

function expectedAuthorization(rm) {
    return {
        materialized_run_plan_sha256: rm.materialized_run_plan_sha256,
        template_allowlist_sha256: rm.template_allowlist_sha256,
        materialized_allowlist_sha256: rm.materialized_allowlist_sha256,
        authorized_harness_sha: rm.authorized_harness_sha,
        authorized_run_plan_sha256: rm.authorized_run_plan_sha256,
        authorized_template_file_sha256: rm.authorized_template_file_sha256,
        authorized_endpoint_or_account_binding: rm.authorized_endpoint_or_account_binding,
    };
}

function derivedShape(group, specs, rows) {
    const shapes = new Set(specs.map((s) => s.pointer_shape));
    if (shapes.size === 1 && shapes.has('cursor_v1')) return 'cursor_v1';
    if (group.group_status !== 'PASS') return null;
    const byId = new Map(specs.map((s) => [s.spec_id, s]));
    const layout = rows.find((r) => byId.get(r.spec_id)?.field_path === 'layout_version');
    if (layout?.normalized_scalar_value === 'immutable_snapshot_v2') return 'immutable_snapshot_v2';
    if (rows.some((r) => byId.get(r.spec_id)?.pointer_shape === 'legacy_v1')) return 'legacy_v1';
    return null;
}

export function verifyLocatorArtifact(locatorOrPath, { plan, templatePolicy, evidence } = {}) {
    const errors = []; const checks = {};
    let artifact;
    try { artifact = readJson(locatorOrPath); } catch (e) { return { ok: false, checks: { V0: false }, errors: [`locator artifact unreadable: ${e.message}`] }; }
    const specs = plan?.structural_locator_specs || [];
    const specById = new Map(specs.map((s) => [s.spec_id, s]));
    const rm = evidence?.run_metadata || {};

    const schema = validateDraft07(loadLocatorArtifactSchema(), artifact);
    checks.V0 = !!plan && !!templatePolicy && !!evidence
        && validateRunManifest(plan, { allowedBuckets: [plan.bucket], templatePolicy }).admissible;
    checks.schema = schema.valid;
    checks.integrity = recomputeLocatorArtifactSha256(artifact) === artifact?.integrity?.artifact_sha256;
    checks.spec_set_hash = artifact?.locator_spec_set_sha256 === locatorSpecSetSha256(specs);

    const groups = artifact?.object_group_results || [];
    const expectedKeys = [...new Set(specs.map((s) => s.key))].sort();
    const groupKeys = groups.map((g) => g.source_object_key);
    checks.V1 = groups.length === expectedKeys.length && new Set(groupKeys).size === groupKeys.length
        && sameJson([...groupKeys].sort(), expectedKeys);

    const resolved = artifact?.resolved_locators || [];
    const unresolved = artifact?.unresolved_locators || [];
    const allRows = [...resolved, ...unresolved];
    const rowIds = allRows.map((r) => r.spec_id);
    checks.V4 = allRows.every((r) => specById.has(r.spec_id));
    checks.V5 = new Set(rowIds).size === rowIds.length;
    checks.V6 = !resolved.some((r) => unresolved.some((u) => u.spec_id === r.spec_id));

    const applicable = [];
    let groupCountsOk = true; let applicabilityOk = true;
    for (const group of groups) {
        const keySpecs = specs.filter((s) => s.key === group.source_object_key);
        const groupRows = allRows.filter((r) => r.source_object_key === group.source_object_key);
        const shape = derivedShape(group, keySpecs, groupRows);
        const cursorOnly = keySpecs.length && keySpecs.every((s) => s.pointer_shape === 'cursor_v1');
        if (group.selected_pointer_shape !== shape
            || group.applicability_status !== (shape || cursorOnly ? 'RESOLVED' : 'UNRESOLVED')) applicabilityOk = false;
        const selected = shape ? keySpecs.filter((s) => s.pointer_shape === shape) : keySpecs;
        applicable.push(...selected);
        const requiredIds = new Set(selected.filter((s) => s.required).map((s) => s.spec_id));
        const rr = resolved.filter((r) => r.source_object_key === group.source_object_key && requiredIds.has(r.spec_id)).length;
        const ur = unresolved.filter((r) => r.source_object_key === group.source_object_key && requiredIds.has(r.spec_id)).length;
        if (group.required_spec_count !== requiredIds.size || group.resolved_spec_count !== rr || group.unresolved_spec_count !== ur) groupCountsOk = false;
        if (groupRows.some((r) => !keySpecs.some((s) => s.spec_id === r.spec_id))) groupCountsOk = false;
    }
    checks.V1 = checks.V1 && applicabilityOk && groupCountsOk;

    const required = applicable.filter((s) => s.required);
    checks.V2 = required.every((s) => rowIds.filter((id) => id === s.spec_id).length === 1);
    checks.V3 = required.every((s) => (resolved.some((r) => r.spec_id === s.spec_id) ? 1 : 0)
        + (unresolved.some((r) => r.spec_id === s.spec_id) ? 1 : 0) === 1);

    checks.V7 = resolved.every((row) => {
        const s = specById.get(row.spec_id);
        return !!s && row.source_object_key === s.key && row.field_path === s.field_path
            && row.pointer_shape === s.pointer_shape && row.semantic_type === s.semantic_type
            && row.scalar_type === s.scalar_type && row.admitted === true;
    });
    checks.V8 = resolved.every((r) => (r.scalar_type === 'string' && typeof r.normalized_scalar_value === 'string')
        || (r.scalar_type === 'integer' && Number.isSafeInteger(r.normalized_scalar_value) && !Object.is(r.normalized_scalar_value, -0)));
    checks.V9 = resolved.every((r) => {
        try { const b = canonicalScalarBytes(r.normalized_scalar_value, r.scalar_type); return b.length === r.value_utf8_bytes && b.length <= specById.get(r.spec_id).max_utf8_bytes; }
        catch { return false; }
    });
    checks.V10 = resolved.every((r) => {
        try {
            const b = canonicalScalarBytes(r.normalized_scalar_value, r.scalar_type);
            return createHash('sha256').update(b).digest('hex') === r.value_sha256;
        } catch { return false; }
    });
    checks.V11 = resolved.every((r) => {
        const p = LOCATOR_PATTERNS[specById.get(r.spec_id)?.value_pattern_id];
        return !!p && p.test(r.normalized_scalar_value);
    });

    let crossOk = true;
    for (const key of expectedKeys) {
        const rows = resolved.filter((r) => r.source_object_key === key);
        const candidates = new Map(rows.map((r) => [r.field_path, r.normalized_scalar_value]));
        const phase = [];
        for (const r of rows) {
            const spec = specById.get(r.spec_id);
            if (!spec) { crossOk = false; continue; }
            try { phase.push({ spec, value: r.normalized_scalar_value, bytes: canonicalScalarBytes(r.normalized_scalar_value, r.scalar_type) }); }
            catch { crossOk = false; }
        }
        const evaluated = evaluateCrossFieldTwoPhase(phase.map((x) => x.spec), phase, candidates);
        if (evaluated.unresolved.length) crossOk = false;
    }
    checks.V12 = crossOk;
    checks.V13 = expectedKeys.every((key) => {
        const rows = resolved.filter((r) => r.source_object_key === key);
        return rows.length < 2 || rows.every((r) => r.source_etag === rows[0].source_etag
            && r.source_byte_length === rows[0].source_byte_length && r.source_byte_sha256 === rows[0].source_byte_sha256);
    });

    const requiredIds = new Set(required.map((s) => s.spec_id));
    const derivedCoverage = {
        applicable_spec_count: applicable.length,
        resolved_required_count: resolved.filter((r) => requiredIds.has(r.spec_id)).length,
        unresolved_required_count: unresolved.filter((r) => requiredIds.has(r.spec_id)).length,
        optional_absent_count: applicable.filter((s) => !s.required && !rowIds.includes(s.spec_id)).length,
    };
    const hardFailure = groups.some((g) => g.group_status !== 'PASS')
        || unresolved.some((r) => r.reason_code === 'LOCATOR_SOURCE_MISMATCH');
    const derivedStatus = hardFailure ? 'FAILED' : (derivedCoverage.unresolved_required_count ? 'PARTIAL' : 'COMPLETE');
    checks.V14 = sameJson(artifact.coverage, derivedCoverage) && artifact.artifact_status === derivedStatus
        && !(required.length && rowIds.length === 0 && artifact.artifact_status === 'COMPLETE');
    checks.V15 = derivedCoverage.unresolved_required_count === 0 || artifact.artifact_status !== 'COMPLETE';
    checks.V16 = sameJson(artifact.run_identity, expectedIdentity(rm)) && sameJson(artifact.authorization, expectedAuthorization(rm));
    checks.V17 = !resolved.some((r) => unresolved.some((u) => u.spec_id === r.spec_id && u.reason_code === 'LOCATOR_SOURCE_MISMATCH'))
        && (!unresolved.some((r) => r.reason_code === 'LOCATOR_SOURCE_MISMATCH') || artifact.artifact_status === 'FAILED');

    for (const [name, pass] of Object.entries(checks)) if (!pass) errors.push(`${name} failed`);
    if (!schema.valid) errors.push(...schema.errors);
    return { ok: Object.values(checks).every(Boolean), checks, errors, derived: { coverage: derivedCoverage, artifact_status: derivedStatus } };
}

export async function verifyArtifact(evidenceOrPath, env = process.env, logPath, runPlanPath, templatePolicyPath, locatorArtifactPath) {
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
    const rpBytesForJoin = runPlanPath ? safeFileBytes(runPlanPath, rootDir) : null;
    let rpParsed = null;
    if (rpBytesForJoin != null) { try { rpParsed = JSON.parse(rpBytesForJoin.toString('utf-8')); } catch { rpParsed = null; } }

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
        const rpBytes = rpBytesForJoin;
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

    // Gate 3 runs only AFTER the raw plan/template authorization-anchor checks
    // above have been independently recomputed (V0 fail-first ordering).
    if (locatorArtifactPath) {
        let locator = null;
        try {
            const bytes = authorized ? safeFileBytes(locatorArtifactPath, rootDir) : fs.readFileSync(locatorArtifactPath);
            locator = bytes ? JSON.parse(bytes.toString('utf-8')) : null;
        } catch { locator = null; }
        const anchorsPass = !authorized || (checks.authorized_run_plan_sha256 === true && checks.authorized_template_file_sha256 === true);
        if (anchorsPass && locator && rpParsed && (tpParsed || !authorized)) {
            const lv = verifyLocatorArtifact(locator, {
                plan: rpParsed, templatePolicy: tpParsed || (templatePolicyPath ? JSON.parse(fs.readFileSync(templatePolicyPath, 'utf-8')) : loadTemplatePolicy()),
                evidence,
            });
            checks.locator_external_join = lv.ok;
            checks.locator_leak_scan = scanLocatorArtifact(locator).pass;
            if (!lv.ok) errors.push(...lv.errors.map((e) => `locator:${e}`));
        } else {
            checks.locator_external_join = false;
            checks.locator_leak_scan = false;
        }
    } else if (authorized) {
        checks.locator_external_join = false;
        checks.locator_leak_scan = false;
    } else {
        checks.locator_external_join = 'SKIPPED';
        checks.locator_leak_scan = 'SKIPPED';
    }

    // H4.4: authorized mode requires EVERY check === true (any 'SKIPPED' or false
    // fails). Offline keeps the SKIPPED-tolerant roll-up.
    const ok = authorized
        ? Object.values(checks).every((v) => v === true)
        : Object.values(checks).every((v) => v === true || v === 'SKIPPED');
    return { ok, checks, errors };
}
