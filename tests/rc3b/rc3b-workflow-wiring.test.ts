// @ts-nocheck
/**
 * RC-3B-P0B workflow wiring (C1A-R1 / B2 + B3 + E). Asserts the read-only R2 job
 * exposes the FUTURE production template-policy path variables and binds the
 * late-bound authorized run id via an ENVIRONMENT-SECRET channel (not a var),
 * while the static pre-dispatch anchors STAY repository vars and the harness
 * stays inert (workflow_dispatch-only, contents:read, gated, no real values).
 * These are STRING assertions over the committed yml -- NO env/var/secret exists.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const YML = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/rc3b-p0b-readonly-harness.yml'), 'utf-8',
);

describe('RC-3B-P0B workflow: template-policy path variables are wired (B2)', () => {
    it('maps RC3B_TEMPLATE_POLICY_PATH + RC3B_AUTHORIZED_TEMPLATE_POLICY_PATH from repo vars', () => {
        expect(YML).toContain('RC3B_TEMPLATE_POLICY_PATH: ${{ vars.RC3B_TEMPLATE_POLICY_PATH }}');
        expect(YML).toContain('RC3B_AUTHORIZED_TEMPLATE_POLICY_PATH: ${{ vars.RC3B_AUTHORIZED_TEMPLATE_POLICY_PATH }}');
    });
    it('the --verify-artifact step still passes the template-policy path', () => {
        expect(YML).toMatch(/--verify-artifact[\s\S]*RC3B_TEMPLATE_POLICY_PATH/);
    });
});

describe('RC-3B-P0B workflow: late-bound run id uses an environment-secret channel (B3)', () => {
    it('RC3B_AUTHORIZED_WORKFLOW_RUN_ID is a SECRET, not a var', () => {
        expect(YML).toContain('RC3B_AUTHORIZED_WORKFLOW_RUN_ID: ${{ secrets.RC3B_AUTHORIZED_WORKFLOW_RUN_ID }}');
        expect(YML).not.toContain('RC3B_AUTHORIZED_WORKFLOW_RUN_ID: ${{ vars.RC3B_AUTHORIZED_WORKFLOW_RUN_ID }}');
    });
    it('the static pre-dispatch anchors STAY repository vars', () => {
        for (const v of [
            'RC3B_RUN_PLAN_PATH', 'RC3B_AUTHORIZED_RUN_PLAN_PATH',
            'RC3B_AUTHORIZED_CARRIER_TAG', 'RC3B_AUTHORIZED_HARNESS_SHA',
            'RC3B_AUTHORIZED_RUN_PLAN_SHA256', 'RC3B_AUTHORIZED_TEMPLATE_FILE_SHA256',
        ]) {
            expect(YML).toContain(`${v}: \${{ vars.${v} }}`);
        }
    });
});

describe('RC-3B-P0B workflow: still inert / build-only (E)', () => {
    it('workflow_dispatch-only, contents:read, gated, dedicated environment, no dispatch', () => {
        expect(YML).toContain('workflow_dispatch: {}');
        expect(YML).toContain('contents: read');
        expect(YML).toContain("if: ${{ vars.RC3B_P0B_ENABLE_R2_RUN == 'true' }}");
        expect(YML).toContain('environment: rc3b-p0b-readonly-r2');
        // R2 credentials remain environment SECRETS (unchanged).
        expect(YML).toContain('R2_ACCOUNT_ID: ${{ secrets.RC3B_R2_ACCOUNT_ID }}');
    });
});
