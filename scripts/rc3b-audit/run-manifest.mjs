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
import {
    OBJECT_CLASSES, isRangeReadableClass, inferClassFromKey,
    classifyStructuralTarget, classifyRangeTarget,
} from './format-policy.mjs';
import { scanForPlaceholders } from './placeholder-scan.mjs';
import { allowlistSha256, runPlanSha256 } from './manifest-hash.mjs';
import { loadTemplatePolicy, templatePolicyCanonicalSha256, matchFamily } from './template-policy.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_FIELDS = [
    'plan_version', 'bucket', 'endpoint_or_account_binding', 'exact_prefixes',
    'structural_keys', 'class_x_targets', 'class_c_head_keys', 'object_class_map',
    'allowed_object_classes', 'caps', 'snapshot_ids', 'template_allowlist_sha256',
    'materialized_allowlist_sha256', 'materialized_run_plan_sha256',
];

export function loadRunManifest(path) {
    const raw = fs.readFileSync(path);
    const plan = JSON.parse(raw.toString('utf-8'));
    return { plan, rawBytes: raw };
}

function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

function checkStructure(plan, errors) {
    for (const f of REQUIRED_FIELDS) {
        if (!(f in plan)) errors.push(`missing required field: ${f}`);
    }
    for (const f of ['exact_prefixes', 'structural_keys', 'class_x_targets', 'class_c_head_keys', 'allowed_object_classes', 'snapshot_ids']) {
        if (f in plan && !Array.isArray(plan[f])) errors.push(`field ${f} must be an array`);
    }
    if ('caps' in plan && !isPlainObject(plan.caps)) errors.push('field caps must be an object');
    if ('object_class_map' in plan && !isPlainObject(plan.object_class_map)) errors.push('field object_class_map must be an object');
    if ('plan_version' in plan && (typeof plan.plan_version !== 'string' || !plan.plan_version)) errors.push('field plan_version must be a non-empty string');
    // OPTIONAL fields: validate type only when present.
    if ('record_spec_ref' in plan && typeof plan.record_spec_ref !== 'string') errors.push('optional field record_spec_ref must be a string');
    if ('authorized_binding' in plan && !isPlainObject(plan.authorized_binding)) errors.push('optional field authorized_binding must be an object');
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
 * Prove EVERY materialized operation is a legal instantiation of a committed
 * template family (right operation, allowlisted bucket/endpoint, family prefix +
 * suffix, class). "Merely an exact string in the plan" is insufficient; an op
 * matching no family makes the plan INADMISSIBLE.
 */
function checkTemplate(plan, tp, errors) {
    if (plan.template_allowlist_sha256 !== templatePolicyCanonicalSha256(tp)) {
        errors.push('template_allowlist_sha256 does not match committed template policy');
    }
    const buckets = tp.bucket_allowlist || [];
    const endpoints = tp.endpoint_or_account_binding_allowlist || [];
    if (!buckets.includes(plan.bucket)) errors.push(`bucket ${JSON.stringify(plan.bucket)} is not in the template bucket allowlist`);
    if (!endpoints.includes(plan.endpoint_or_account_binding)) errors.push(`endpoint ${JSON.stringify(plan.endpoint_or_account_binding)} is not in the template endpoint allowlist`);

    const classMap = plan.object_class_map || {};
    for (const prefix of plan.exact_prefixes || []) {
        if (!matchFamily(tp, { operation: 'LIST', prefix })) errors.push(`LIST prefix ${JSON.stringify(prefix)} is not template-derived`);
    }
    for (const key of plan.structural_keys || []) {
        const declared = classMap[key] || inferClassFromKey(key);
        const eff = classifyStructuralTarget(key, declared).effectiveClass;
        if (eff !== 'STRUCTURAL_JSON' || !matchFamily(tp, { operation: 'GET_META', key, effectiveClass: 'STRUCTURAL_JSON' })) {
            errors.push(`structural key ${JSON.stringify(key)} is not a GET_META template-derived STRUCTURAL_JSON family instantiation`);
        }
    }
    for (const key of plan.class_c_head_keys || []) {
        const eff = classMap[key] || inferClassFromKey(key);
        if (!matchFamily(tp, { operation: 'HEAD', key, effectiveClass: eff })) errors.push(`HEAD key ${JSON.stringify(key)} is not template-derived`);
    }
    for (const t of plan.class_x_targets || []) {
        const declared = (t && t.object_class) || (t && classMap[t.key]) || (t && inferClassFromKey(t.key));
        const eff = classifyRangeTarget(t ? t.key : '', declared).effectiveClass;
        if (eff !== 'NXVF_SHARD' || !t || !matchFamily(tp, { operation: 'RANGE', key: t.key, effectiveClass: 'NXVF_SHARD' })) {
            errors.push(`class_x target ${JSON.stringify(t && t.key)} is not a RANGE template-derived NXVF_SHARD family instantiation`);
        }
    }
}

/**
 * @param {object} plan  parsed run manifest
 * @param {{allowedBuckets:string[], templatePolicy?:object}} opts  committed bucket allowlist (external)
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

    const tp = opts.templatePolicy || loadTemplatePolicy();
    checkTemplate(plan, tp, errors);

    return { admissible: errors.length === 0, errors };
}
