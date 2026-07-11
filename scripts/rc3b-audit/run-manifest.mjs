/**
 * RC-3B-P0B -- run-manifest (RUN PLAN) loader + validator.
 *
 * The harness consumes a committed, machine-readable, fully MATERIALIZED plan.
 * There is NO free-form prefix input anywhere. validateRunManifest() runs every
 * fail-before-network gate: required fields, exact allowlists (no placeholders),
 * an allowlisted bucket, caps that only LOWER (never raise) the immutable
 * ceilings, range targets that are NXVF locator-bound (never monolithic
 * gzip/zstd), and the two recomputable integrity hashes. A single failure makes
 * the whole plan INADMISSIBLE -- the harness never opens a client for it.
 */

import fs from 'fs';
import { capViolations } from './caps.mjs';
import { OBJECT_CLASSES, isRangeReadableClass } from './format-policy.mjs';
import { scanForPlaceholders } from './placeholder-scan.mjs';
import { allowlistSha256, runPlanSha256 } from './manifest-hash.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_FIELDS = [
    'bucket', 'endpoint_or_account_binding', 'exact_prefixes', 'structural_keys',
    'class_x_targets', 'class_c_head_keys', 'allowed_object_classes', 'caps',
    'snapshot_ids', 'template_allowlist_sha256', 'materialized_allowlist_sha256',
    'materialized_run_plan_sha256',
];

export function loadRunManifest(path) {
    const raw = fs.readFileSync(path);
    const plan = JSON.parse(raw.toString('utf-8'));
    return { plan, rawBytes: raw };
}

function checkStructure(plan, errors) {
    for (const f of REQUIRED_FIELDS) {
        if (!(f in plan)) errors.push(`missing required field: ${f}`);
    }
    for (const f of ['exact_prefixes', 'structural_keys', 'class_x_targets', 'class_c_head_keys', 'allowed_object_classes', 'snapshot_ids']) {
        if (f in plan && !Array.isArray(plan[f])) errors.push(`field ${f} must be an array`);
    }
    if ('caps' in plan && (typeof plan.caps !== 'object' || plan.caps === null || Array.isArray(plan.caps))) {
        errors.push('field caps must be an object');
    }
}

function checkHashes(plan, errors) {
    for (const f of ['template_allowlist_sha256', 'materialized_allowlist_sha256', 'materialized_run_plan_sha256']) {
        if (typeof plan[f] !== 'string' || !HEX64.test(plan[f])) errors.push(`field ${f} must be a 64-char lowercase hex sha256`);
    }
    const wantAllow = allowlistSha256(plan);
    if (HEX64.test(plan.materialized_allowlist_sha256 || '') && plan.materialized_allowlist_sha256 !== wantAllow) {
        errors.push(`materialized_allowlist_sha256 mismatch: plan=${plan.materialized_allowlist_sha256} recomputed=${wantAllow}`);
    }
    const wantPlan = runPlanSha256(plan);
    if (HEX64.test(plan.materialized_run_plan_sha256 || '') && plan.materialized_run_plan_sha256 !== wantPlan) {
        errors.push(`materialized_run_plan_sha256 mismatch: plan=${plan.materialized_run_plan_sha256} recomputed=${wantPlan}`);
    }
}

function checkClasses(plan, errors) {
    for (const cls of plan.allowed_object_classes || []) {
        if (!OBJECT_CLASSES.includes(cls)) errors.push(`allowed_object_classes contains unknown class: ${cls}`);
    }
    for (const t of plan.class_x_targets || []) {
        if (!t || typeof t !== 'object') { errors.push('class_x_targets entry is not an object'); continue; }
        if (typeof t.key !== 'string' || !t.key) errors.push('class_x target missing string key');
        if (!Number.isInteger(t.offset) || t.offset < 0) errors.push(`class_x target ${t.key} has invalid offset`);
        if (!Number.isInteger(t.length) || t.length <= 0) errors.push(`class_x target ${t.key} has invalid length`);
        if (!isRangeReadableClass(t.object_class)) {
            errors.push(`class_x target ${t.key} must be NXVF_SHARD (got ${t.object_class}) -- monolithic gzip/zstd is not range-readable`);
        }
    }
}

/**
 * @param {object} plan  parsed run manifest
 * @param {{allowedBuckets:string[]}} opts  committed bucket allowlist (external)
 * @returns {{admissible:boolean, errors:string[]}}
 */
export function validateRunManifest(plan, opts = {}) {
    const errors = [];
    if (!plan || typeof plan !== 'object') return { admissible: false, errors: ['plan is not an object'] };
    checkStructure(plan, errors);
    if (errors.length) return { admissible: false, errors };

    const allowedBuckets = opts.allowedBuckets || [];
    if (!allowedBuckets.includes(plan.bucket)) {
        errors.push(`bucket ${JSON.stringify(plan.bucket)} is not in the committed bucket allowlist [${allowedBuckets.join(', ')}]`);
    }

    const placeholders = scanForPlaceholders({
        bucket: plan.bucket,
        endpoint_or_account_binding: plan.endpoint_or_account_binding,
        exact_prefixes: plan.exact_prefixes,
        structural_keys: plan.structural_keys,
        class_c_head_keys: plan.class_c_head_keys,
        class_x_targets: (plan.class_x_targets || []).map((t) => t.key),
        snapshot_ids: plan.snapshot_ids,
    });
    for (const p of placeholders) errors.push(`unresolved placeholder ${JSON.stringify(p.token)} at ${p.path}`);

    const capBad = capViolations(plan.caps || {});
    for (const c of capBad) errors.push(`cap violation (lower-only rule): ${c}`);

    checkClasses(plan, errors);
    checkHashes(plan, errors);

    return { admissible: errors.length === 0, errors };
}
