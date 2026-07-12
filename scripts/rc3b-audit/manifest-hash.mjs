/**
 * RC-3B-P0B -- deterministic run-manifest hashing (PURE).
 *
 * Two committed hashes bind the plan:
 *   materialized_allowlist_sha256  -- over the canonical allowlist (bucket +
 *                                     sorted prefixes/keys/range-targets), and
 *   materialized_run_plan_sha256   -- over EVERY execution-affecting field of
 *                                     the materialized plan (plan_version,
 *                                     bucket, endpoint binding, optional
 *                                     authorized_binding, allowlist,
 *                                     object_class_map, allowed classes,
 *                                     snapshot ids, caps, template hash, and the
 *                                     optional record_spec_ref).
 * Both are RECOMPUTABLE here and by the workflow, so any post-materialization
 * tamper flips the hash and is rejected before any network activity.
 */

import { createHash } from 'crypto';
import { canonicalLocatorSpecs } from './locator-extract.mjs';

function sha256Hex(str) { return createHash('sha256').update(Buffer.from(str, 'utf-8')).digest('hex'); }

function sortedTargets(targets = []) {
    return [...targets]
        .map((t) => ({ key: t.key, offset: t.offset, length: t.length, object_class: t.object_class }))
        .sort((a, b) => `${a.key}|${a.offset}|${a.length}`.localeCompare(`${b.key}|${b.offset}|${b.length}`));
}

export function canonicalAllowlist(plan) {
    return {
        bucket: plan.bucket,
        exact_prefixes: [...(plan.exact_prefixes || [])].sort(),
        structural_keys: [...(plan.structural_keys || [])].sort(),
        class_c_head_keys: [...(plan.class_c_head_keys || [])].sort(),
        class_x_targets: sortedTargets(plan.class_x_targets),
    };
}

/** Sorted [[key, class], ...] pairs of the object_class_map (deterministic). */
export function canonicalObjectClassMap(plan) {
    const map = plan.object_class_map || {};
    return Object.keys(map).sort().map((k) => [k, map[k]]);
}

/**
 * The canonical run plan covers EVERY execution-affecting field. Only the two
 * hash fields themselves (materialized_allowlist_sha256, materialized_run_plan_sha256)
 * are excluded, so any post-materialization tamper of a covered field flips the
 * hash and the plan is rejected before any network activity.
 */
export function canonicalRunPlan(plan) {
    return {
        plan_version: plan.plan_version ?? null,
        bucket: plan.bucket,
        endpoint_or_account_binding: plan.endpoint_or_account_binding,
        authorized_binding: plan.authorized_binding ?? null,
        allowlist: canonicalAllowlist(plan),
        object_class_map: canonicalObjectClassMap(plan),
        allowed_object_classes: [...(plan.allowed_object_classes || [])].sort(),
        snapshot_ids: [...(plan.snapshot_ids || [])].sort(),
        structural_locator_specs: canonicalLocatorSpecs(plan.structural_locator_specs || []),
        caps: plan.caps || {},
        template_allowlist_sha256: plan.template_allowlist_sha256 ?? null,
        record_spec_ref: plan.record_spec_ref ?? null,
    };
}

export function allowlistSha256(plan) {
    return sha256Hex(JSON.stringify(canonicalAllowlist(plan)));
}

export function runPlanSha256(plan) {
    return sha256Hex(JSON.stringify(canonicalRunPlan(plan)));
}
