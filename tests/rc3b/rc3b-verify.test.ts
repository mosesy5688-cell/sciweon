// @ts-nocheck
/**
 * RC-3B-P0B real-artifact post-validation (--verify-artifact). A clean self-test
 * artifact passes every STRUCTURAL check offline (authorized-SHA checks SKIPPED);
 * a poisoned artifact (bad artifact_sha256, or a FAIL scan / free-text value)
 * reports ok:false.
 */
import { describe, it, expect } from 'vitest';
import { verifyArtifact } from '../../scripts/rc3b-audit/verify-artifact.mjs';
import { runSelfTest } from '../../scripts/rc3b-audit/self-test.mjs';

const OFFLINE = {}; // no RC3B_P0B_RUN_AUTHORIZED => authorized checks SKIPPED

async function cleanArtifact() { return (await runSelfTest()).evidence; }

describe('RC-3B-P0B verify-artifact: clean artifact', () => {
    it('passes the structural checks offline; the three authorized checks are SKIPPED', async () => {
        const r = await verifyArtifact(await cleanArtifact(), OFFLINE);
        expect(r.ok).toBe(true);
        expect(r.checks.schema).toBe(true);
        expect(r.checks.artifact_sha256).toBe(true);
        expect(r.checks.leak_policy_sha256).toBe(true);
        expect(r.checks.scan_results_pass).toBe(true);
        expect(r.checks.network_calls_after_stop).toBe(true);
        expect(r.checks.authorized_commit_sha).toBe('SKIPPED');
        expect(r.checks.authorized_run_plan_sha256).toBe('SKIPPED');
        expect(r.checks.authorized_template_sha256).toBe('SKIPPED');
    });
});

describe('RC-3B-P0B verify-artifact: poisoned artifact', () => {
    it('a tampered artifact_sha256 -> ok:false', async () => {
        const ev = await cleanArtifact();
        ev.integrity_evidence.artifact_sha256 = 'f'.repeat(64);
        const r = await verifyArtifact(ev, OFFLINE);
        expect(r.ok).toBe(false);
        expect(r.checks.artifact_sha256).toBe(false);
    });

    it('a FAIL scan / free-text value -> ok:false', async () => {
        const ev = await cleanArtifact();
        ev.integrity_evidence.artifact_scan_result = 'FAIL';
        ev.inventory_records[0].hash_or_etag = 'leaked free text with spaces';
        const r = await verifyArtifact(ev, OFFLINE);
        expect(r.ok).toBe(false);
        expect(r.checks.scan_results_pass).toBe(false);
    });
});
