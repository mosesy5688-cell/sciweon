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
import { syntheticRunManifest, SYNTHETIC_BUCKET, SYNTHETIC_ALLOWED_BUCKETS } from '../../scripts/rc3b-audit/self-test.mjs';

function reseal(plan) {
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    return plan;
}
const OK = { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS };

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
