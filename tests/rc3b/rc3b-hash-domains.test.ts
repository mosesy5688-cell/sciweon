// @ts-nocheck
/**
 * RC-3B-P0B template hash DOMAIN SEPARATION (CHANGE A). The RAW-FILE hash
 * (authorized_template_file_sha256, the external Founder anchor) and the CANONICAL
 * hash (template_allowlist_sha256, the semantic policy identity) are DIFFERENT
 * values living in DIFFERENT fields, compared in DIFFERENT places, and NEVER
 * cross-compared. Swapping one into the other's slot fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertFounderAuthorization, sha256OfFileBytes } from '../../scripts/rc3b-audit/authorization.mjs';
import {
    TEMPLATE_POLICY_PATH, templatePolicyFileSha256, templatePolicyCanonicalSha256,
} from '../../scripts/rc3b-audit/template-policy.mjs';
import { validateRunManifest } from '../../scripts/rc3b-audit/run-manifest.mjs';
import { allowlistSha256, runPlanSha256 } from '../../scripts/rc3b-audit/manifest-hash.mjs';
import { syntheticRunManifest, SYNTHETIC_ALLOWED_BUCKETS } from '../../scripts/rc3b-audit/self-test.mjs';

const FILE = templatePolicyFileSha256();
const CANON = templatePolicyCanonicalSha256();
const OK = { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc3b-hashdom-'));
const runPlanPath = path.join(dir, 'run-plan.json');
fs.writeFileSync(runPlanPath, JSON.stringify({ synthetic: true }), 'utf-8');
const HARNESS = 'a'.repeat(40);

function authEnv(over = {}) {
    return {
        RC3B_P0B_RUN_AUTHORIZED: 'true',
        RC3B_AUTHORIZED_HARNESS_SHA: HARNESS,
        RC3B_AUTHORIZED_RUN_PLAN_SHA256: sha256OfFileBytes(runPlanPath),
        RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256: FILE,
        RC3B_AUTHORIZED_RUN_PLAN_PATH: runPlanPath,
        GITHUB_SHA: HARNESS,
        ...over,
    };
}
const OPTS = { runPlanPath, templatePolicyPath: TEMPLATE_POLICY_PATH };
function reseal(plan) {
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    return plan;
}

describe('RC-3B-P0B template hash domains', () => {
    it('the raw-file hash and the canonical hash are DIFFERENT values', () => {
        expect(FILE).toMatch(/^[0-9a-f]{64}$/);
        expect(CANON).toMatch(/^[0-9a-f]{64}$/);
        expect(FILE).not.toBe(CANON);
    });

    it('authorization binds the RAW-FILE domain: the file anchor equals the raw bytes sha', () => {
        const r = assertFounderAuthorization(authEnv(), OPTS);
        expect(r.authorized_template_file_sha256).toBe(FILE);
    });

    it('SWAP: the CANONICAL hash in the template-FILE anchor fails authorization', () => {
        expect(() => assertFounderAuthorization(authEnv({ RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256: CANON }), OPTS))
            .toThrow(/MISSING_AUTHORIZATION/);
    });

    it('a raw template FILE tamper (one extra byte) fails authorization', () => {
        const tampered = path.join(dir, 'tampered-template.json');
        fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(TEMPLATE_POLICY_PATH), Buffer.from(' ')]));
        expect(() => assertFounderAuthorization(authEnv(), { runPlanPath, templatePolicyPath: tampered }))
            .toThrow(/MISSING_AUTHORIZATION/);
    });

    it('the plan binds the CANONICAL domain: the committed canonical passes admissibility', () => {
        const plan = syntheticRunManifest();
        expect(plan.template_allowlist_sha256).toBe(CANON);
        expect(validateRunManifest(plan, OK).admissible).toBe(true);
    });

    it('SWAP: the raw-FILE hash in the canonical plan field is INADMISSIBLE (semantic tamper)', () => {
        const plan = reseal({ ...syntheticRunManifest(), template_allowlist_sha256: FILE });
        const r = validateRunManifest(plan, OK);
        expect(r.admissible).toBe(false);
        expect(r.errors.some((e) => /template_allowlist_sha256 does not match committed template policy/.test(e))).toBe(true);
    });
});
