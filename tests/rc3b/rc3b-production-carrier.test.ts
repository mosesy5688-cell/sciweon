// @ts-nocheck
/**
 * RC-3B-P0B-C4-E-T2-R1 -- wire the production-carrier OFFLINE validator into the
 * CI-covered Vitest suite so it becomes a continuous regression gate. CI runs
 * `npm test` (full vitest discovery), so this tests/rc3b/*.test.ts file is executed
 * on every CI run and will fail the build the moment any production-carrier offline
 * invariant regresses.
 *
 * This test is INERT: it merely invokes the landed offline validator, which uses
 * ONLY synthetic values (a fake account id + a synthetic format-valid session token)
 * and ZERO network / ZERO secrets / ZERO real production values. No real Account ID,
 * endpoint, credential, secret, or R2 access is introduced here.
 */
import { describe, it, expect } from 'vitest';
import { runProductionCarrierOfflineTest } from '../../scripts/rc3b-audit/prod/production-carrier.offline-test.mjs';

describe('RC-3B-P0B production-carrier offline validator (CI regression gate)', () => {
    it('passes every non-informational offline invariant', async () => {
        const r = await runProductionCarrierOfflineTest();
        expect(r.ok).toBe(true);

        // Non-informational checks only (underscore-prefixed keys are informational).
        const names = Object.keys(r.checks).filter((k) => !k.startsWith('_'));

        // Guard against a vacuous pass (e.g. an empty checks object).
        expect(names.length).toBeGreaterThanOrEqual(20);

        // Every non-informational check must be exactly true, named for failure clarity.
        for (const k of names) expect(r.checks[k], `check ${k}`).toBe(true);

        // Key checks must be present by name, so silently dropping one also fails.
        for (const key of [
            'policy_file_sha256',
            'run_plan_file_sha256',
            'b2_session_token_byte_exact',
            'b2_no_token_fails',
            'b2_malformed_token_fails',
            'caps_zero',
            'scope_gate_before_client',
        ]) expect(names).toContain(key);
    });
});
