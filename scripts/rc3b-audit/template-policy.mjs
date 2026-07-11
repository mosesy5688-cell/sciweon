/**
 * RC-3B-P0B -- machine-enforced template policy (committed governance contract).
 *
 * template-policy.json is the VERSIONED, canonical, hashable list of the LEGAL
 * template families a Founder-authorized run plan may INSTANTIATE. Every
 * materialized operation in a run plan MUST be a legal instantiation of one
 * family (right operation, allowlisted bucket/endpoint, key under a family
 * prefix + suffix, class matches). "Merely an exact string in the plan" is not
 * enough -- an op that matches no family makes the plan INADMISSIBLE
 * (fail-before-network). This module is PURE (fs + crypto only).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_POLICY_PATH = path.join(HERE, 'template-policy.json');

export function loadTemplatePolicy(policyPath = TEMPLATE_POLICY_PATH) {
    return JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
}

function canonicalFamily(f) {
    return {
        family_id: f.family_id,
        operation: f.operation,
        object_class: f.object_class ?? null,
        key_prefix: f.key_prefix,
        key_suffixes: [...(f.key_suffixes || [])].sort(),
    };
}

/** Deterministic, hashable projection: families + allowlists sorted. */
export function canonicalTemplatePolicy(tp) {
    return {
        template_policy_version: tp.template_policy_version,
        bucket_allowlist: [...(tp.bucket_allowlist || [])].sort(),
        endpoint_or_account_binding_allowlist: [...(tp.endpoint_or_account_binding_allowlist || [])].sort(),
        families: [...(tp.families || [])]
            .map(canonicalFamily)
            .sort((a, b) => a.family_id.localeCompare(b.family_id)),
    };
}

export function templatePolicySha256(tp = loadTemplatePolicy()) {
    return createHash('sha256')
        .update(Buffer.from(JSON.stringify(canonicalTemplatePolicy(tp)), 'utf-8'))
        .digest('hex');
}

/**
 * Return the matching family for a would-be operation, or null.
 *   LIST: family.operation==='LIST' AND prefix === family.key_prefix (exact).
 *   HEAD/GET_META/RANGE: family.operation matches AND key starts with the family
 *     prefix AND some family suffix matches (case-insensitive) AND
 *     (family.object_class===null OR family.object_class===effectiveClass).
 */
export function matchFamily(tp, { operation, key, prefix, effectiveClass }) {
    const families = tp && Array.isArray(tp.families) ? tp.families : [];
    for (const f of families) {
        if (f.operation !== operation) continue;
        if (operation === 'LIST') {
            if (prefix === f.key_prefix) return f;
            continue;
        }
        const k = String(key);
        if (!k.startsWith(f.key_prefix)) continue;
        const lower = k.toLowerCase();
        const suffixes = f.key_suffixes || [];
        if (!suffixes.some((s) => lower.endsWith(String(s).toLowerCase()))) continue;
        if (f.object_class !== null && f.object_class !== effectiveClass) continue;
        return f;
    }
    return null;
}

/** Throws if bucket / endpoint are not on the committed template allowlists. */
export function assertBucketAndEndpoint(tp, { bucket, endpoint }) {
    const buckets = (tp && tp.bucket_allowlist) || [];
    const endpoints = (tp && tp.endpoint_or_account_binding_allowlist) || [];
    if (!buckets.includes(bucket)) {
        throw new Error(`[RC3B TEMPLATE] bucket ${JSON.stringify(bucket)} is not in the committed template bucket allowlist`);
    }
    if (!endpoints.includes(endpoint)) {
        throw new Error(`[RC3B TEMPLATE] endpoint ${JSON.stringify(endpoint)} is not in the committed template endpoint allowlist`);
    }
}

/** Convenience: is `op` a template operation this policy governs? */
export function isTemplateDerived(tp, op) {
    const families = tp && Array.isArray(tp.families) ? tp.families : [];
    return families.some((f) => f.operation === op);
}
