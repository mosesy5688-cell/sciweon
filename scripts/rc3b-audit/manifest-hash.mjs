/**
 * RC-3B-P0B -- deterministic run-manifest hashing (PURE).
 *
 * Two committed hashes bind the plan:
 *   materialized_allowlist_sha256  -- over the canonical allowlist (bucket +
 *                                     sorted prefixes/keys/range-targets), and
 *   materialized_run_plan_sha256   -- over the whole materialized plan
 *                                     (allowlist + allowed classes + snapshot
 *                                     ids + caps).
 * Both are RECOMPUTABLE here and by the workflow, so any post-materialization
 * tamper flips the hash and is rejected before any network activity.
 */

import { createHash } from 'crypto';

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

export function canonicalRunPlan(plan) {
    return {
        allowlist: canonicalAllowlist(plan),
        allowed_object_classes: [...(plan.allowed_object_classes || [])].sort(),
        snapshot_ids: [...(plan.snapshot_ids || [])].sort(),
        caps: plan.caps || {},
    };
}

export function allowlistSha256(plan) {
    return sha256Hex(JSON.stringify(canonicalAllowlist(plan)));
}

export function runPlanSha256(plan) {
    return sha256Hex(JSON.stringify(canonicalRunPlan(plan)));
}
