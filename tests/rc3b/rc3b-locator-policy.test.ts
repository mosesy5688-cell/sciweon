// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { validateRunManifest } from '../../scripts/rc3b-audit/run-manifest.mjs';
import { allowlistSha256, runPlanSha256 } from '../../scripts/rc3b-audit/manifest-hash.mjs';
import { loadTemplatePolicy, matchFamily, templatePolicyCanonicalSha256 } from '../../scripts/rc3b-audit/template-policy.mjs';
import { decideOperation } from '../../scripts/rc3b-audit/operation-matrix.mjs';
import { IMMUTABLE_CAPS } from '../../scripts/rc3b-audit/caps.mjs';
import { syntheticRunManifest, SYNTHETIC_ALLOWED_BUCKETS } from '../../scripts/rc3b-audit/self-test.mjs';

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function reseal(plan, tp = loadTemplatePolicy()) {
    plan.template_allowlist_sha256 = templatePolicyCanonicalSha256(tp);
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    return validateRunManifest(plan, { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, templatePolicy: tp });
}
function invalid(mutatePlan, mutatePolicy) {
    const plan = syntheticRunManifest(); const tp = clone(loadTemplatePolicy());
    mutatePlan?.(plan); mutatePolicy?.(tp);
    return reseal(plan, tp);
}

describe('Gate 1 exact-key/equal-or-narrow and uniqueness counterexamples', () => {
    it('CE1/N33 required template rule cannot be downgraded optional', () => {
        const r = invalid((p) => { p.structural_locator_specs[0].required = false; });
        expect(r.admissible).toBe(false); expect(r.errors.join(' ')).toMatch(/required.*downgraded/);
    });
    it('CE2/CE13/N34/N43 prefix+suffix match cannot substitute for exact_key', () => {
        const r = invalid((p) => {
            p.structural_locator_specs.forEach((s) => { s.key = 'synthetic/prefix/other.json'; });
            p.object_class_map['synthetic/prefix/other.json'] = 'STRUCTURAL_JSON';
        });
        expect(r.admissible).toBe(false); expect(r.errors.join(' ')).toMatch(/exact-key/);
        expect(matchFamily(loadTemplatePolicy(), { operation: 'GET_LOCATOR', key: 'synthetic/prefix/other.json', effectiveClass: 'STRUCTURAL_JSON' })).toBe(null);
    });
    it('N21/N32 a field absent from template rules is inadmissible', () => {
        for (const field of ['created_at', 'inner_url', 'archive_url']) {
            const r = invalid((p) => { p.structural_locator_specs[0].field_path = field; });
            expect(r.admissible).toBe(false);
        }
    });
    it('N22 changed type/pattern/normalization or wider length is inadmissible', () => {
        const mutations = [
            (s) => { s.scalar_type = 'integer'; }, (s) => { s.value_pattern_id = 'ISO_DATE'; },
            (s) => { s.normalization = 'TRIM'; }, (s) => { s.max_utf8_bytes = 65; },
            (s) => { s.cross_field_rules = []; },
        ];
        for (const mutate of mutations) expect(invalid((p) => mutate(p.structural_locator_specs[0])).admissible).toBe(false);
    });
    it('optional template permission may be promoted required and max bytes may narrow', () => {
        const tp = clone(loadTemplatePolicy());
        const rule = tp.families.find((f) => f.operation === 'GET_LOCATOR').locator_rules[1];
        rule.required = false;
        const plan = syntheticRunManifest(); plan.structural_locator_specs[1].max_utf8_bytes = 8;
        expect(reseal(plan, tp).admissible).toBe(true);
    });
    it('CE9/N19/N41 duplicate spec_id or target is rejected without silent dedup', () => {
        expect(invalid((p) => { p.structural_locator_specs[1].spec_id = p.structural_locator_specs[0].spec_id; }).admissible).toBe(false);
        expect(invalid((p) => { p.structural_locator_specs[1] = { ...p.structural_locator_specs[0], spec_id: 'OTHER_ID' }; }).admissible).toBe(false);
    });
    it('CE10/N42 duplicate template family_id, rule, or cross-field id is rejected', () => {
        expect(invalid(null, (tp) => { tp.families[1].family_id = tp.families[0].family_id; }).admissible).toBe(false);
        expect(invalid(null, (tp) => { const f = tp.families.find((x) => x.operation === 'GET_LOCATOR'); f.locator_rules.push(clone(f.locator_rules[0])); }).admissible).toBe(false);
        expect(invalid((p) => { p.structural_locator_specs[0].cross_field_rules.push('LAYOUT_SELECTS_SPEC_SET'); }).admissible).toBe(false);
    });
});

describe('hash, caps, and operation-class closure', () => {
    it('N15 locator spec mutation flips the canonical plan hash', () => {
        const p = syntheticRunManifest(); const before = runPlanSha256(p);
        p.structural_locator_specs[0].max_utf8_bytes -= 1;
        expect(runPlanSha256(p)).not.toBe(before);
    });
    it('locked locator cap ceilings are exact and lower-only', () => {
        expect(IMMUTABLE_CAPS.MAX_GET_LOCATOR_REQUESTS_PER_RUN).toBe(16);
        expect(IMMUTABLE_CAPS.MAX_LOCATOR_SPECS_PER_RUN).toBe(64);
        expect(IMMUTABLE_CAPS.MAX_LOCATOR_VALUES_PER_RUN).toBe(64);
        expect(IMMUTABLE_CAPS.MAX_LOCATOR_VALUE_BYTES_SINGLE).toBe(512);
        expect(IMMUTABLE_CAPS.MAX_LOCATOR_VALUE_BYTES_TOTAL).toBe(8192);
        expect(invalid((p) => { p.caps.MAX_LOCATOR_SPECS_PER_RUN = 65; }).admissible).toBe(false);
    });
    it('N9/N10 class matrix keeps payload HEAD-only and NXVF RANGE-only', () => {
        expect(decideOperation({ operation: 'GET_LOCATOR', effectiveClass: 'STRUCTURAL_JSON' }).allow).toBe(true);
        for (const cls of ['MONOLITHIC_GZIP', 'MONOLITHIC_ZSTD', 'PAYLOAD_JSONL', 'NXVF_SHARD']) {
            expect(decideOperation({ operation: 'GET_LOCATOR', effectiveClass: cls }).allow).toBe(false);
        }
    });
    it('N47 boolean scalar specs are rejected by the run-plan gate', () => {
        expect(invalid((p) => { p.structural_locator_specs[0].scalar_type = 'boolean'; }).admissible).toBe(false);
    });
});
