// @ts-nocheck
/**
 * RC-3B-P0B endpoint/account binding (CHANGE B). Proves the plan is bound to the
 * ACTUAL R2 account derived from the environment BEFORE any client: an authorized
 * account passes; a different account, a missing account, and a malformed plan
 * binding each throw fail-before-client. The observed binding is COMPUTED from the
 * env account, never the plan label copied blindly.
 */
import { describe, it, expect } from 'vitest';
import {
    normalizeAccountId, deriveEndpointBinding, resolveAccountId, assertEndpointBinding,
} from '../../scripts/rc3b-audit/endpoint-binding.mjs';

const ACCT_A = 'account-a-id';
const ACCT_B = 'account-b-id';
const BIND_A = deriveEndpointBinding(ACCT_A);
const BIND_B = deriveEndpointBinding(ACCT_B);

describe('RC-3B-P0B endpoint-binding: pure derivation', () => {
    it('normalizeAccountId trims + lowercases', () => {
        expect(normalizeAccountId('  ACcount-Id  ')).toBe('account-id');
    });
    it('deriveEndpointBinding is deterministic 64-hex and account-specific', () => {
        expect(BIND_A).toMatch(/^[0-9a-f]{64}$/);
        expect(deriveEndpointBinding(ACCT_A)).toBe(BIND_A);
        expect(BIND_A).not.toBe(BIND_B);
    });
    it('resolveAccountId prefers R2_ACCOUNT_ID then CLOUDFLARE then CF, else null', () => {
        expect(resolveAccountId({ R2_ACCOUNT_ID: 'r2', CLOUDFLARE_ACCOUNT_ID: 'cf' })).toBe('r2');
        expect(resolveAccountId({ CLOUDFLARE_ACCOUNT_ID: 'cf' })).toBe('cf');
        expect(resolveAccountId({ CF_ACCOUNT_ID: 'x' })).toBe('x');
        expect(resolveAccountId({})).toBe(null);
    });
});

describe('RC-3B-P0B endpoint-binding: assertEndpointBinding fail-before-client', () => {
    it('authorized account A + plan bound to A -> PASS with observed == derived(A)', () => {
        const r = assertEndpointBinding({ R2_ACCOUNT_ID: ACCT_A }, { endpoint_or_account_binding: BIND_A });
        expect(r.endpoint_binding_match).toBe('PASS');
        expect(r.authorized_endpoint_or_account_binding).toBe(BIND_A);
        expect(r.observed_endpoint_or_account_binding).toBe(deriveEndpointBinding(ACCT_A));
        expect(r.observed_endpoint_or_account_binding).toBe(r.authorized_endpoint_or_account_binding);
    });
    it('account B against a plan authorized for A -> BINDING_MISMATCH', () => {
        expect(() => assertEndpointBinding({ R2_ACCOUNT_ID: ACCT_B }, { endpoint_or_account_binding: BIND_A }))
            .toThrow(/BINDING_MISMATCH/);
    });
    it('missing account id -> MISSING_ACCOUNT_ID', () => {
        expect(() => assertEndpointBinding({}, { endpoint_or_account_binding: BIND_A }))
            .toThrow(/MISSING_ACCOUNT_ID/);
    });
    it('a malformed (non 64-hex) plan binding -> MALFORMED_BINDING', () => {
        expect(() => assertEndpointBinding({ R2_ACCOUNT_ID: ACCT_A }, { endpoint_or_account_binding: 'synthetic-account' }))
            .toThrow(/MALFORMED_BINDING/);
    });
    it('the observed binding is COMPUTED from env, not the plan label copied blindly', () => {
        // Plan LABELS account A, but the env account derives B -> must mismatch.
        expect(() => assertEndpointBinding({ R2_ACCOUNT_ID: ACCT_B }, { endpoint_or_account_binding: BIND_A }))
            .toThrow(/BINDING_MISMATCH/);
        // Success path: observed strictly equals the env-derived value.
        const r = assertEndpointBinding({ R2_ACCOUNT_ID: ACCT_B }, { endpoint_or_account_binding: BIND_B });
        expect(r.observed_endpoint_or_account_binding).toBe(deriveEndpointBinding(ACCT_B));
    });
    it('never leaks the raw account id in an error message', () => {
        try {
            assertEndpointBinding({ R2_ACCOUNT_ID: ACCT_B }, { endpoint_or_account_binding: BIND_A });
        } catch (e) {
            expect(String(e.message)).not.toContain(ACCT_B);
        }
    });
});
