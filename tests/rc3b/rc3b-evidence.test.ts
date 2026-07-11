// @ts-nocheck
/**
 * RC-3B-P0B evidence + leak-scan + schema + logger. Proves the artifact is
 * structurally free-text-incapable, the leak scanner has PASS (positive) and
 * FAIL (negative) controls, the Draft-07 validator rejects malformed evidence
 * (incl. the READ-ONLY-R2 commit/run/hash requirements), and the logger cannot
 * carry body bytes. Closes with the full offline self-test.
 */
import { describe, it, expect } from 'vitest';
import { buildInventoryRecord, sanitizeFieldPaths } from '../../scripts/rc3b-audit/evidence-builder.mjs';
import { runLeakScan } from '../../scripts/rc3b-audit/leak-scanner.mjs';
import { validateDraft07 } from '../../scripts/rc3b-audit/schema-validate.mjs';
import { loadEvidenceSchema, buildEvidenceFromRun } from '../../scripts/rc3b-audit/evidence-assembly.mjs';
import { StructuralLogger } from '../../scripts/rc3b-audit/logger.mjs';
import { runReadOnlyAudit } from '../../scripts/rc3b-audit/harness.mjs';
import {
    runSelfTest, poisonedEvidence, syntheticRunManifest, syntheticRunMetadata,
    makeSyntheticFakeClient, SYNTHETIC_ALLOWED_BUCKETS,
} from '../../scripts/rc3b-audit/self-test.mjs';

async function validEvidence() { return (await runSelfTest()).evidence; }

describe('RC-3B-P0B: the evidence builder cannot emit body-derived free text', () => {
    it('sanitizeFieldPaths drops any path not on the committed allowlist', () => {
        expect(sanitizeFieldPaths(['snapshot_id', 'patient reported severe headache', 'manifest_hash']))
            .toEqual(['snapshot_id', 'manifest_hash']);
    });

    it('buildInventoryRecord filters a poisoned observed_field_paths list', () => {
        const rec = buildInventoryRecord({ object_key: 'k', sample: { sample_kind: 'FIELD-PATH-ONLY', observed_field_paths: ['manifest_hash', 'leaked body text here'] } });
        expect(rec.targeted_sample.observed_field_paths).toEqual(['manifest_hash']);
    });

    it('a free-text classification is caught by the leak scan inside the builder (artifact FAIL)', async () => {
        const plan = syntheticRunManifest();
        const runResult = await runReadOnlyAudit(plan, Buffer.from('{}'), { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, clientOverride: makeSyntheticFakeClient() });
        const specs = { 'synthetic/prefix/manifest.json': { content_class: 'free text leaked from the object body' } };
        const built = buildEvidenceFromRun(runResult, plan, { run_metadata: syntheticRunMetadata(plan), record_specs: specs });
        expect(built.scanResult.artifact_scan_result).toBe('FAIL');
        expect(built.scanResult.pass).toBe(false);
    });
});

describe('RC-3B-P0B: leak scanner positive + negative controls', () => {
    it('a clean artifact PASSES every dimension', async () => {
        const scan = runLeakScan({ artifact: await validEvidence(), logLines: [] });
        expect(scan.pass).toBe(true);
        expect(scan.artifact_scan_result).toBe('PASS');
        expect(scan.forbidden_property_scan_result).toBe('PASS');
        expect(scan.leak_policy_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a poisoned free-text value FAILS the scan (negative control)', async () => {
        const scan = runLeakScan({ artifact: poisonedEvidence(await validEvidence()), logLines: [] });
        expect(scan.pass).toBe(false);
        expect(scan.artifact_scan_result).toBe('FAIL');
    });

    it('a forbidden property NAME anywhere FAILS the forbidden-property scan', async () => {
        const ev = await validEvidence();
        ev.run_metadata.body = 'anything';
        const scan = runLeakScan({ artifact: ev, logLines: [] });
        expect(scan.forbidden_property_scan_result).toBe('FAIL');
    });

    it('a dumped blob in a log line FAILS the log scan', () => {
        const scan = runLeakScan({ artifact: {}, logLines: ['[RC3B] ok', 'X'.repeat(400)] });
        expect(scan.log_scan_result).toBe('FAIL');
    });
});

describe('RC-3B-P0B: Draft-07 schema validation', () => {
    it('the byte-identical schema validates the clean artifact', async () => {
        const r = validateDraft07(loadEvidenceSchema(), await validEvidence());
        expect(r.valid).toBe(true);
        expect(r.errors).toEqual([]);
    });

    it('the self-test artifact carries the new attempts_after_stop + authorized_* fields', async () => {
        const ev = await validEvidence();
        expect(ev.operation_evidence.attempts_after_stop).toBe(0);
        expect(ev.operation_evidence.network_calls_after_stop).toBe(0);
        expect(ev.run_metadata.authorized_harness_sha).toMatch(/^[0-9a-f]{40}$/);
        expect(ev.run_metadata.authorized_run_plan_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(ev.run_metadata.authorized_template_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a run_metadata missing an authorized_* field is rejected by the schema', async () => {
        const ev = await validEvidence();
        delete ev.run_metadata.authorized_harness_sha;
        const r = validateDraft07(loadEvidenceSchema(), ev);
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => /authorized_harness_sha/.test(e))).toBe(true);
    });

    it('an artifact with a nonzero network_calls_after_stop is rejected (const 0)', async () => {
        const ev = await validEvidence();
        ev.operation_evidence.network_calls_after_stop = 1;
        const r = validateDraft07(loadEvidenceSchema(), ev);
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => /network_calls_after_stop/.test(e))).toBe(true);
    });

    it('a missing required top-level section is rejected', async () => {
        const ev = await validEvidence();
        delete ev.followup_queue;
        const r = validateDraft07(loadEvidenceSchema(), ev);
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => /followup_queue/.test(e))).toBe(true);
    });

    it('a READ-ONLY-R2 artifact with a bad commit/run/hash is rejected', async () => {
        const ev = await validEvidence();
        ev.run_metadata.commit_sha = 'not-a-40-hex';
        ev.run_metadata.workflow_run_id = '';
        ev.run_metadata.materialized_run_plan_sha256 = 'zz';
        const r = validateDraft07(loadEvidenceSchema(), ev);
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => /commit_sha|materialized_run_plan_sha256|workflow_run_id/.test(e))).toBe(true);
    });
});

describe('RC-3B-P0B: body bytes never enter logs', () => {
    it('a Buffer / long string field is reduced to <bytes:N> / <redacted:...>', () => {
        const log = new StructuralLogger();
        log.event('range', { key: 'p/s.bin', bytes: Buffer.from('SECRET_BODY_TEXT with spaces and payload') });
        log.event('meta', { body: 'another very secret payload string '.repeat(10) });
        const joined = log.lines.join('\n');
        expect(joined).not.toContain('SECRET_BODY_TEXT');
        expect(joined).not.toContain('secret payload');
        expect(joined).toContain('<bytes:');
        expect(joined).toContain('<redacted:');
    });
});

describe('RC-3B-P0B: full offline self-test', () => {
    it('every self-test check is green', async () => {
        const r = await runSelfTest();
        expect(r.ok).toBe(true);
        for (const [, v] of Object.entries(r.checks)) expect(v).toBe(true);
    });
});
