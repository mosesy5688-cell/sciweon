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
import { capViolations, resolveCaps } from './caps.mjs';
import {
    OBJECT_CLASSES, isRangeReadableClass, inferClassFromKey,
    classifyStructuralTarget, classifyRangeTarget,
} from './format-policy.mjs';
import { scanForPlaceholders } from './placeholder-scan.mjs';
import { allowlistSha256, runPlanSha256 } from './manifest-hash.mjs';
import {
    loadTemplatePolicy, templatePolicyCanonicalSha256, matchFamily, nullObjectClassNonListFamilies,
} from './template-policy.mjs';
import { validateLocatorSpecAgainstRule, validateLocatorSpecShape } from './locator-extract.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_FIELDS = [
    'plan_version', 'bucket', 'endpoint_or_account_binding', 'exact_prefixes',
    'structural_keys', 'class_x_targets', 'class_c_head_keys', 'object_class_map',
    'allowed_object_classes', 'caps', 'snapshot_ids', 'template_allowlist_sha256',
    'materialized_allowlist_sha256', 'materialized_run_plan_sha256',
    'structural_locator_specs',
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
    if ('structural_locator_specs' in plan && !Array.isArray(plan.structural_locator_specs)) errors.push('field structural_locator_specs must be an array');
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
    // CHANGE D: a NON-LIST family carrying a null/absent object_class is INVALID
    // (no object_class:null HEAD/GET_META/RANGE bypass) -- reject the whole policy.
    const badNull = nullObjectClassNonListFamilies(tp);
    for (const id of badNull) errors.push(`template family ${JSON.stringify(id)} is a non-LIST family with a null object_class (invalid)`);

    if (plan.template_allowlist_sha256 !== templatePolicyCanonicalSha256(tp)) {
        errors.push('template_allowlist_sha256 does not match committed template policy');
    }
    const buckets = tp.bucket_allowlist || [];
    const endpoints = tp.endpoint_or_account_binding_allowlist || [];
    if (!buckets.includes(plan.bucket)) errors.push(`bucket ${JSON.stringify(plan.bucket)} is not in the template bucket allowlist`);
    if (!endpoints.includes(plan.endpoint_or_account_binding)) errors.push(`endpoint ${JSON.stringify(plan.endpoint_or_account_binding)} is not in the template endpoint allowlist`);

    // CHANGE F: reject any exact_prefix / key under a forbidden_prefix (fail-
    // before-network) EVEN IF a family would otherwise match it.
    const forbidden = tp.forbidden_prefixes || [];
    const underForbidden = (k) => forbidden.some((fp) => String(k).startsWith(fp));
    for (const p of plan.exact_prefixes || []) if (underForbidden(p)) errors.push(`LIST prefix ${JSON.stringify(p)} is under a forbidden_prefix`);
    for (const k of plan.structural_keys || []) if (underForbidden(k)) errors.push(`structural key ${JSON.stringify(k)} is under a forbidden_prefix`);
    for (const k of plan.class_c_head_keys || []) if (underForbidden(k)) errors.push(`HEAD key ${JSON.stringify(k)} is under a forbidden_prefix`);
    for (const t of plan.class_x_targets || []) if (t && underForbidden(t.key)) errors.push(`class_x target ${JSON.stringify(t.key)} is under a forbidden_prefix`);
    for (const s of plan.structural_locator_specs || []) if (s && underForbidden(s.key)) errors.push(`locator key ${JSON.stringify(s.key)} is under a forbidden_prefix`);

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

export function checkLocatorSpecs(plan, tp, errors = []) {
    const specs = plan.structural_locator_specs || [];
    const caps = resolveCaps(plan.caps || {});
    if (specs.length > caps.MAX_LOCATOR_SPECS_PER_RUN) errors.push(`structural_locator_specs exceeds cap (${specs.length}>${caps.MAX_LOCATOR_SPECS_PER_RUN})`);

    const families = tp && Array.isArray(tp.families) ? tp.families : [];
    const familyIds = new Set(); const templateRuleKeys = new Set();
    for (const family of families) {
        if (familyIds.has(family.family_id)) errors.push(`duplicate template family_id ${JSON.stringify(family.family_id)}`);
        familyIds.add(family.family_id);
        if (family.operation !== 'GET_LOCATOR') continue;
        const familyExtras = Object.keys(family).filter((k) => !['family_id', 'operation', 'object_class', 'exact_key', 'locator_rules'].includes(k));
        if (familyExtras.length) errors.push(`GET_LOCATOR family ${JSON.stringify(family.family_id)} has unexpected fields: ${familyExtras.join(',')}`);
        if (family.object_class !== 'STRUCTURAL_JSON' || typeof family.exact_key !== 'string' || !family.exact_key) {
            errors.push(`GET_LOCATOR family ${JSON.stringify(family.family_id)} must bind exact_key + STRUCTURAL_JSON`);
        }
        if (!Array.isArray(family.locator_rules) || !family.locator_rules.length) errors.push(`GET_LOCATOR family ${JSON.stringify(family.family_id)} has no locator_rules`);
        for (const rule of family.locator_rules || []) {
            const ruleExtras = Object.keys(rule).filter((k) => !['field_path', 'semantic_type', 'scalar_type', 'value_pattern_id', 'normalization', 'max_utf8_bytes', 'required', 'pointer_shape', 'cross_field_rules'].includes(k));
            if (ruleExtras.length) errors.push(`template locator rule ${family.family_id}/${rule.field_path} has unexpected fields: ${ruleExtras.join(',')}`);
            const shapeErrors = validateLocatorSpecShape({ spec_id: 'RULE', key: family.exact_key, ...rule });
            for (const e of shapeErrors) errors.push(`template locator rule ${family.family_id}/${rule.field_path}: ${e}`);
            const rk = `${family.exact_key}|${rule.pointer_shape}|${rule.field_path}`;
            if (templateRuleKeys.has(rk)) errors.push(`duplicate template locator rule ${rk}`);
            templateRuleKeys.add(rk);
        }
    }

    const specIds = new Set(); const specKeys = new Set();
    const classMap = plan.object_class_map || {};
    for (const spec of specs) {
        for (const e of validateLocatorSpecShape(spec)) errors.push(`locator spec ${spec?.spec_id || '<unknown>'}: ${e}`);
        if (specIds.has(spec.spec_id)) errors.push(`duplicate locator spec_id ${JSON.stringify(spec.spec_id)}`);
        specIds.add(spec.spec_id);
        const sk = `${spec.key}|${spec.pointer_shape}|${spec.field_path}`;
        if (specKeys.has(sk)) errors.push(`duplicate locator spec target ${sk}`);
        specKeys.add(sk);
        const declared = classMap[spec.key] || inferClassFromKey(spec.key);
        const eff = classifyStructuralTarget(spec.key, declared).effectiveClass;
        const matching = families.filter((f) => f.operation === 'GET_LOCATOR'
            && f.object_class === 'STRUCTURAL_JSON' && f.exact_key === spec.key && eff === 'STRUCTURAL_JSON');
        if (matching.length !== 1) {
            errors.push(`locator spec ${JSON.stringify(spec.spec_id)} key is not bound to exactly one exact-key GET_LOCATOR family`);
            continue;
        }
        const rules = (matching[0].locator_rules || []).filter((r) => r.field_path === spec.field_path && r.pointer_shape === spec.pointer_shape);
        if (rules.length !== 1) {
            errors.push(`locator spec ${JSON.stringify(spec.spec_id)} does not match exactly one template locator_rule`);
            continue;
        }
        for (const e of validateLocatorSpecAgainstRule(spec, rules[0])) errors.push(`locator spec ${spec.spec_id}: ${e}`);
    }
    return errors;
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
        structural_locator_keys: (plan.structural_locator_specs || []).map((s) => s.key),
    });
    for (const p of placeholders) errors.push(`unresolved placeholder ${JSON.stringify(p.token)} at ${p.path}`);

    const capBad = capViolations(plan.caps || {});
    for (const c of capBad) errors.push(`cap violation (lower-only rule): ${c}`);

    checkClasses(plan, errors);
    checkHashes(plan, errors);

    const tp = opts.templatePolicy || loadTemplatePolicy();
    checkTemplate(plan, tp, errors);
    checkLocatorSpecs(plan, tp, errors);

    return { admissible: errors.length === 0, errors };
}
