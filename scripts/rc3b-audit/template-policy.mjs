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
 *
 * SYNTHETIC-ONLY: the committed template-policy.json is scoped
 * "policy_scope": "SYNTHETIC-ONLY" (hash-bound). A PRODUCTION run requires a
 * SEPARATELY audited carrier under its OWN gate -- the exact production template
 * policy + materialized run plan + post-merge harness SHA binding + BOTH the
 * raw-file and canonical hashes + the exact account/endpoint binding + per-run
 * caps. No production policy is defined here.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { canonicalLocatorRules } from './locator-extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_POLICY_PATH = path.join(HERE, 'template-policy.json');

export function loadTemplatePolicy(policyPath = TEMPLATE_POLICY_PATH) {
    return JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
}

function canonicalFamily(f) {
    if (f.operation === 'GET_LOCATOR') {
        return {
            family_id: f.family_id,
            operation: f.operation,
            object_class: f.object_class ?? null,
            exact_key: f.exact_key,
            locator_rules: canonicalLocatorRules(f.locator_rules || []),
        };
    }
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
        policy_scope: tp.policy_scope ?? null,
        bucket_allowlist: [...(tp.bucket_allowlist || [])].sort(),
        endpoint_or_account_binding_allowlist: [...(tp.endpoint_or_account_binding_allowlist || [])].sort(),
        families: [...(tp.families || [])]
            .map(canonicalFamily)
            .sort((a, b) => a.family_id.localeCompare(b.family_id)),
        // CHANGE F: forbidden_prefixes is part of the hashed policy identity (an
        // empty array when absent). A key/prefix under a forbidden_prefix is
        // rejected before network EVEN IF a family would match (run-manifest).
        forbidden_prefixes: [...(tp.forbidden_prefixes || [])].sort(),
    };
}

/**
 * CANONICAL (semantic) template-policy hash = sha256 of the sorted projection.
 * This is the SEMANTIC policy identity bound in the plan as
 * `template_allowlist_sha256`. It is a DIFFERENT domain from the raw-file hash
 * below and the two are NEVER cross-compared.
 */
export function templatePolicyCanonicalSha256(tp = loadTemplatePolicy()) {
    return createHash('sha256')
        .update(Buffer.from(JSON.stringify(canonicalTemplatePolicy(tp)), 'utf-8'))
        .digest('hex');
}

/**
 * RAW-FILE template-policy hash = sha256 of the EXACT committed policy bytes.
 * This is the EXTERNAL Founder anchor (`authorized_template_file_sha256`). It is
 * a DIFFERENT value from the canonical hash and lives in a DIFFERENT field.
 */
export function templatePolicyFileSha256(policyPath = TEMPLATE_POLICY_PATH) {
    return createHash('sha256').update(fs.readFileSync(policyPath)).digest('hex');
}

/**
 * Return the matching family for a would-be operation, or null.
 *   LIST: family.operation==='LIST' AND prefix === family.key_prefix (exact); a
 *     LIST family MAY carry object_class:null.
 *   HEAD/GET_META/RANGE (CHANGE D): family.operation matches AND the family
 *     carries an EXPLICIT object_class (a null/absent object_class can match ONLY
 *     LIST -- no non-LIST bypass) AND key starts with the family prefix AND some
 *     family suffix matches (case-insensitive) AND family.object_class===effectiveClass.
 */
export function matchFamily(tp, { operation, key, prefix, effectiveClass }) {
    const families = tp && Array.isArray(tp.families) ? tp.families : [];
    for (const f of families) {
        if (f.operation !== operation) continue;
        if (operation === 'LIST') {
            if (prefix === f.key_prefix) return f;
            continue;
        }
        if (operation === 'GET_LOCATOR') {
            if (f.object_class === 'STRUCTURAL_JSON'
                && effectiveClass === 'STRUCTURAL_JSON'
                && typeof key === 'string' && key === f.exact_key) return f;
            continue;
        }
        // NON-LIST: a null/absent object_class NEVER matches (no object_class:null spoof).
        if (f.object_class === null || f.object_class === undefined) continue;
        const k = String(key);
        if (!k.startsWith(f.key_prefix)) continue;
        const lower = k.toLowerCase();
        const suffixes = f.key_suffixes || [];
        if (!suffixes.some((s) => lower.endsWith(String(s).toLowerCase()))) continue;
        if (f.object_class !== effectiveClass) continue;
        return f;
    }
    return null;
}

/**
 * CHANGE D: family_ids of NON-LIST families that ILLEGALLY carry a null/absent
 * object_class. Such a policy is INVALID (a non-LIST family must be (operation,
 * exactly-one-class)-scoped); run-manifest.checkTemplate rejects it.
 */
export function nullObjectClassNonListFamilies(tp) {
    const families = tp && Array.isArray(tp.families) ? tp.families : [];
    return families
        .filter((f) => f.operation !== 'LIST' && (f.object_class === null || f.object_class === undefined))
        .map((f) => f.family_id);
}

/** The declared policy scope (CHANGE F): 'SYNTHETIC-ONLY' | 'PRODUCTION-READONLY' | null. */
export function templatePolicyScope(tp = loadTemplatePolicy()) {
    return (tp && tp.policy_scope) || null;
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
