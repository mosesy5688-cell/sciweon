/**
 * RC-3B-P0B -- closed resolved-locators artifact builder. PURE.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { canonicalLocatorSpecs } from './locator-extract.mjs';
import { assertSourceBoundLocatorResult } from './locator-source-binding.mjs';
import { validateDraft07 } from './schema-validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOCATOR_ARTIFACT_SCHEMA_PATH = path.join(HERE, 'locator-artifact-schema.json');
export const LOCATOR_ARTIFACT_SCHEMA_ID = 'RC3B_C3_R2_LOCATOR_ARTIFACT_SCHEMA_v0.1';

function hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function hashJson(value) { return hashBytes(Buffer.from(JSON.stringify(value), 'utf-8')); }

export function locatorSpecSetSha256(specs) { return hashJson(canonicalLocatorSpecs(specs)); }

export function loadLocatorArtifactSchema() {
    return JSON.parse(fs.readFileSync(LOCATOR_ARTIFACT_SCHEMA_PATH, 'utf-8'));
}

export function recomputeLocatorArtifactSha256(artifact) {
    const clone = JSON.parse(JSON.stringify(artifact));
    delete clone.integrity.artifact_sha256;
    return hashJson(clone);
}

function runIdentity(runMetadata) {
    return {
        bucket: runMetadata.bucket,
        r2_endpoint_or_account_binding: runMetadata.r2_endpoint_or_account_binding,
        carrier_tag: runMetadata.carrier_tag,
        workflow_run_id: String(runMetadata.workflow_run_id),
        workflow_run_attempt: runMetadata.workflow_run_attempt,
        commit_sha: runMetadata.commit_sha,
        tag_or_ref: runMetadata.tag_or_ref,
        mode: runMetadata.mode,
    };
}

function authorization(runMetadata) {
    return {
        materialized_run_plan_sha256: runMetadata.materialized_run_plan_sha256,
        template_allowlist_sha256: runMetadata.template_allowlist_sha256,
        materialized_allowlist_sha256: runMetadata.materialized_allowlist_sha256,
        authorized_harness_sha: runMetadata.authorized_harness_sha,
        authorized_run_plan_sha256: runMetadata.authorized_run_plan_sha256,
        authorized_template_file_sha256: runMetadata.authorized_template_file_sha256,
        authorized_endpoint_or_account_binding: runMetadata.authorized_endpoint_or_account_binding,
    };
}

function groupRow(result) {
    const required = result.applicable_specs.filter((s) => s.required);
    const requiredIds = new Set(required.map((s) => s.spec_id));
    const resolved = result.resolved.filter((r) => requiredIds.has(r.spec_id)).length;
    const unresolved = result.unresolved.filter((r) => requiredIds.has(r.spec_id)).length;
    return {
        source_object_key: result.source_object_key,
        applicability_status: result.applicability_status,
        selected_pointer_shape: result.selected_pointer_shape,
        group_status: result.group_status,
        required_spec_count: required.length,
        resolved_spec_count: resolved,
        unresolved_spec_count: unresolved,
    };
}

function failureResult(failure) {
    const specs = failure.specs || [];
    const cursor = specs.length > 0 && specs.every((s) => s.pointer_shape === 'cursor_v1');
    return {
        source_object_key: failure.source_object_key,
        applicability_status: cursor ? 'RESOLVED' : 'UNRESOLVED',
        selected_pointer_shape: cursor ? 'cursor_v1' : null,
        group_status: failure.group_status || 'NOT_FOUND',
        applicable_specs: specs,
        resolved: [],
        unresolved: specs.filter((s) => s.required).map((s) => ({
            spec_id: s.spec_id, source_object_key: s.key,
            reason_code: failure.reason_code || 'OBJECT_NOT_FOUND',
        })),
        optional_absent_spec_ids: specs.filter((s) => !s.required).map((s) => s.spec_id),
        source_binding_status: 'NOT_APPLICABLE',
    };
}

/**
 * Every value-bearing result must carry the unforgeable source-binding brand.
 * objectFailures is a value-free diagnostic lane for objects that could not be
 * read at all (for example HEAD 404); it cannot admit rows.
 */
export function buildLocatorArtifact({ sourceBoundResults = [], objectFailures = [], plan, runMetadata }) {
    const bound = sourceBoundResults.map(assertSourceBoundLocatorResult);
    const failures = objectFailures.map(failureResult);
    const results = [...bound, ...failures].sort((a, b) => a.source_object_key.localeCompare(b.source_object_key));
    const allKeys = new Set((plan.structural_locator_specs || []).map((s) => s.key));
    const resultKeys = results.map((r) => r.source_object_key);
    if (new Set(resultKeys).size !== resultKeys.length || resultKeys.some((k) => !allKeys.has(k)) || resultKeys.length !== allKeys.size) {
        throw new Error('LOCATOR_OBJECT_GROUP_COVERAGE_MISMATCH');
    }

    const resolved = results.flatMap((r) => r.resolved);
    const unresolved = results.flatMap((r) => r.unresolved);
    const optionalAbsent = results.reduce((n, r) => n + r.optional_absent_spec_ids.length, 0);
    const applicable = results.flatMap((r) => r.applicable_specs);
    const requiredIds = new Set(applicable.filter((s) => s.required).map((s) => s.spec_id));
    const resolvedRequired = resolved.filter((r) => requiredIds.has(r.spec_id)).length;
    const unresolvedRequired = unresolved.filter((r) => requiredIds.has(r.spec_id)).length;
    const hardFailure = results.some((r) => r.group_status !== 'PASS' || r.source_binding_status === 'FAILED')
        || unresolved.some((r) => r.reason_code === 'LOCATOR_SOURCE_MISMATCH');
    const status = hardFailure ? 'FAILED' : (unresolvedRequired ? 'PARTIAL' : 'COMPLETE');

    const artifact = {
        schema_id: LOCATOR_ARTIFACT_SCHEMA_ID,
        run_identity: runIdentity(runMetadata),
        authorization: authorization(runMetadata),
        locator_spec_set_sha256: locatorSpecSetSha256(plan.structural_locator_specs || []),
        artifact_status: status,
        coverage: {
            applicable_spec_count: applicable.length,
            resolved_required_count: resolvedRequired,
            unresolved_required_count: unresolvedRequired,
            optional_absent_count: optionalAbsent,
        },
        object_group_results: results.map(groupRow),
        resolved_locators: resolved,
        unresolved_locators: unresolved,
        integrity: { artifact_sha256: '0'.repeat(64) },
    };
    artifact.integrity.artifact_sha256 = recomputeLocatorArtifactSha256(artifact);
    const schema = validateDraft07(loadLocatorArtifactSchema(), artifact);
    return { artifact, schema };
}
