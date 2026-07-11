// @ts-nocheck
/**
 * RC-3B-P0B run-manifest (RUN PLAN) validation: placeholders, bucket allowlist,
 * lower-only caps, integrity-hash consistency, and NXVF-only range targets --
 * all fail-before-network gates enforced at load time.
 */
import { describe, it, expect } from 'vitest';
import { validateRunManifest } from '../../scripts/rc3b-audit/run-manifest.mjs';
import { capViolations, resolveCaps, IMMUTABLE_CAPS } from '../../scripts/rc3b-audit/caps.mjs';
import { allowlistSha256, runPlanSha256 } from '../../scripts/rc3b-audit/manifest-hash.mjs';
import { loadTemplatePolicy, templatePolicyCanonicalSha256 } from '../../scripts/rc3b-audit/template-policy.mjs';
import { syntheticRunManifest, SYNTHETIC_BUCKET, SYNTHETIC_ALLOWED_BUCKETS } from '../../scripts/rc3b-audit/self-test.mjs';

function reseal(plan) {
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    return plan;
}
const OK = { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS };
const PREFIX = 'synthetic/prefix/';

describe('RC-3B-P0B run manifest: the synthetic plan is admissible + hash-consistent', () => {
    it('a clean synthetic plan validates and its hashes recompute', () => {
        const plan = syntheticRunManifest();
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(true);
        expect(r.errors).toEqual([]);
        expect(plan.materialized_run_plan_sha256).toBe(runPlanSha256(plan));
    });
});

describe('RC-3B-P0B run manifest: rejections', () => {
    it('an unresolved placeholder in a prefix is rejected', () => {
        const plan = syntheticRunManifest();
        plan.exact_prefixes = ['data/<date>/'];
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /placeholder/.test(e))).toBe(true);
    });

    it('a non-allowlisted bucket is rejected', () => {
        const plan = syntheticRunManifest();
        const r = validateRunManifest(plan, { allowedBuckets: ['some-other-bucket'] });
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /bucket/.test(e))).toBe(true);
    });

    it('a cap that tries to RAISE an immutable ceiling is rejected (lower-only rule)', () => {
        const plan = reseal({ ...syntheticRunManifest(), caps: { MAX_RANGE_REQUESTS_PER_RUN: 999999 } });
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /cap violation/.test(e))).toBe(true);
    });

    it('a tampered materialized_run_plan_sha256 is rejected (integrity)', () => {
        const plan = syntheticRunManifest();
        plan.materialized_run_plan_sha256 = 'f'.repeat(64);
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /materialized_run_plan_sha256 mismatch/.test(e))).toBe(true);
    });

    it('a non-NXVF (monolithic gzip) range target is rejected', () => {
        const plan = reseal({
            ...syntheticRunManifest(),
            class_x_targets: [{ key: 'synthetic/prefix/x.gz', offset: 0, length: 64, object_class: 'MONOLITHIC_GZIP' }],
        });
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /NXVF_SHARD/.test(e))).toBe(true);
    });
});

describe('RC-3B-P0B run manifest: canonical-hash mutation coverage (tamper => mismatch => inadmissible)', () => {
    const mutations = {
        plan_version: (p) => { p.plan_version = 'x.y.z'; },
        endpoint_or_account_binding: (p) => { p.endpoint_or_account_binding = 'synthetic-account-2'; },
        object_class_map: (p) => { p.object_class_map = { ...p.object_class_map, [`${PREFIX}extra.json`]: 'STRUCTURAL_JSON' }; },
        allowed_object_classes: (p) => { p.allowed_object_classes = ['STRUCTURAL_JSON']; },
        snapshot_ids: (p) => { p.snapshot_ids = ['2099-12-31/9-9']; },
        caps: (p) => { p.caps = { MAX_HEAD_REQUESTS_PER_RUN: 7 }; },
        template_allowlist_sha256: (p) => { p.template_allowlist_sha256 = 'f'.repeat(64); },
        record_spec_ref: (p) => { p.record_spec_ref = 'rc3b-p0b-record-spec-v9'; },
        exact_prefixes: (p) => { p.exact_prefixes = [`${PREFIX}sub/`]; },
        structural_keys: (p) => { p.structural_keys = [`${PREFIX}other.json`]; },
        class_c_head_keys: (p) => { p.class_c_head_keys = [`${PREFIX}other.jsonl.gz`]; },
        class_x_targets: (p) => { p.class_x_targets = [{ key: `${PREFIX}other.bin`, offset: 0, length: 64, object_class: 'NXVF_SHARD' }]; },
    };
    for (const [field, mutate] of Object.entries(mutations)) {
        it(`mutating ${field} WITHOUT resealing is inadmissible (run-plan hash mismatch)`, () => {
            const plan = syntheticRunManifest();
            mutate(plan); // NO reseal
            const r = validateRunManifest(plan, OK);
            expect(r.admissible).toBe(false);
            expect(r.errors.some((e) => /materialized_run_plan_sha256 mismatch/.test(e))).toBe(true);
        });
    }

    it('a valid-hex template_allowlist_sha256 that != committed policy is inadmissible (even when re-sealed)', () => {
        const plan = reseal({ ...syntheticRunManifest(), template_allowlist_sha256: 'f'.repeat(64) });
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /template_allowlist_sha256 does not match committed template policy/.test(e))).toBe(true);
    });

    it('a plan op that is not template-derived is inadmissible (even when re-sealed)', () => {
        const plan = reseal({ ...syntheticRunManifest(), exact_prefixes: [PREFIX, 'not-a-family-prefix/'] });
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /not template-derived/.test(e))).toBe(true);
    });
});

describe('RC-3B-P0B run manifest: CHANGE D/F template-policy rejections', () => {
    it('a policy whose non-LIST family carries object_class:null is INADMISSIBLE (CHANGE D)', () => {
        const tp = loadTemplatePolicy();
        const bad = { ...tp, families: tp.families.map((f) => (f.operation === 'HEAD' ? { ...f, object_class: null } : f)) };
        const r = validateRunManifest(syntheticRunManifest(), { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, templatePolicy: bad });
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /null object_class/.test(e))).toBe(true);
    });

    it('a key under a forbidden_prefix is INADMISSIBLE even when a family matches (CHANGE F)', () => {
        const tp = loadTemplatePolicy();
        const withForbidden = { ...tp, forbidden_prefixes: ['synthetic/prefix/'] };
        const plan = reseal({ ...syntheticRunManifest(), template_allowlist_sha256: templatePolicyCanonicalSha256(withForbidden) });
        const r = validateRunManifest(plan, { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, templatePolicy: withForbidden });
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /forbidden_prefix/.test(e))).toBe(true);
    });
});

describe('RC-3B-P0B caps: lower-only clamping', () => {
    it('capViolations flags a higher-than-ceiling request', () => {
        expect(capViolations({ MAX_HEAD_REQUESTS_PER_RUN: IMMUTABLE_CAPS.MAX_HEAD_REQUESTS_PER_RUN + 1 })).toHaveLength(1);
        expect(capViolations({ MAX_HEAD_REQUESTS_PER_RUN: 5 })).toEqual([]);
    });

    it('resolveCaps clamps a raise down to the ceiling and honors a lower value', () => {
        const eff = resolveCaps({ MAX_RANGE_REQUESTS_PER_RUN: 999999, MAX_HEAD_REQUESTS_PER_RUN: 5 });
        expect(eff.MAX_RANGE_REQUESTS_PER_RUN).toBe(IMMUTABLE_CAPS.MAX_RANGE_REQUESTS_PER_RUN);
        expect(eff.MAX_HEAD_REQUESTS_PER_RUN).toBe(5);
    });
});
