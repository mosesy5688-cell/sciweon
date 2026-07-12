// @ts-nocheck
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { Budget } from '../../scripts/rc3b-audit/budget.mjs';
import { makeReadOnlyR2Client } from '../../scripts/rc3b-audit/readonly-client.mjs';
import { loadTemplatePolicy } from '../../scripts/rc3b-audit/template-policy.mjs';
import { extractLocators } from '../../scripts/rc3b-audit/locator-extract.mjs';
import { verifySourceBinding, isSourceBoundLocatorResult } from '../../scripts/rc3b-audit/locator-source-binding.mjs';
import { buildLocatorArtifact, loadLocatorArtifactSchema } from '../../scripts/rc3b-audit/locator-artifact.mjs';
import { buildEvidenceFromRun } from '../../scripts/rc3b-audit/evidence-assembly.mjs';
import { runReadOnlyAudit } from '../../scripts/rc3b-audit/harness.mjs';
import { syntheticRunManifest, syntheticLocatorSpecs, manifestBodyBuffer, syntheticRunMetadata, makeSyntheticFakeClient, SYNTHETIC_ALLOWED_BUCKETS } from '../../scripts/rc3b-audit/self-test.mjs';

function clientScenario(over = {}) {
    const plan = syntheticRunManifest(); const raw = manifestBodyBuffer(); const calls = [];
    const fake = { async send(command) {
        const type = command.constructor.name; calls.push(type);
        if (type === 'HeadObjectCommand') return { ETag: over.headEtag ?? 'etag-1', ContentLength: over.headLength ?? raw.length };
        if (type === 'GetObjectCommand') return { ETag: over.getEtag ?? 'etag-1', ContentLength: over.getLength ?? raw.length, Body: over.body ?? raw };
        throw new Error(`unexpected ${type}`);
    } };
    const budget = new Budget(plan.caps);
    return { plan, raw, calls, budget, client: makeReadOnlyR2Client(fake, plan, budget, loadTemplatePolicy()) };
}

describe('Gate 2 same-buffer runtime and integrity', () => {
    it('CE15/N45 exactly one GET is issued for extraction plus binding', async () => {
        const s = clientScenario();
        const result = await s.client.getLocatorScalars('synthetic/prefix/manifest.json');
        expect(isSourceBoundLocatorResult(result)).toBe(true);
        expect(s.calls).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
    });
    it('different HEAD/GET ETag fails with INTEGRITY_ANOMALY and zero admitted result', async () => {
        const s = clientScenario({ headEtag: 'a', getEtag: 'b' });
        await expect(s.client.getLocatorScalars('synthetic/prefix/manifest.json')).rejects.toThrow(/INTEGRITY_ANOMALY/);
        expect(s.calls).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
    });
    it('different HEAD/GET/buffer length fails integrity', async () => {
        const s = clientScenario({ getLength: manifestBodyBuffer().length - 1 });
        await expect(s.client.getLocatorScalars('synthetic/prefix/manifest.json')).rejects.toThrow(/INTEGRITY_ANOMALY/);
    });
    it('CE3/N35 a valid-looking row differing from source becomes mismatch with zero admitted values', () => {
        const raw = manifestBodyBuffer(); const ss = syntheticLocatorSpecs();
        const extraction = extractLocators(raw, ss);
        extraction.resolved.find((r) => r.spec_id === 'SYN_SNAPSHOT_DATE').normalized_scalar_value = '2026-01-02';
        const result = verifySourceBinding(raw, extraction, ss, { head_etag: 'e', get_etag: 'e', head_content_length: raw.length, get_content_length: raw.length });
        expect(result.source_binding_status).toBe('FAILED');
        expect(result.resolved).toEqual([]);
        expect(result.unresolved.every((r) => r.reason_code === 'LOCATOR_SOURCE_MISMATCH')).toBe(true);
    });
});

describe('opaque brand, closed schema, object groups, and GET_META regression', () => {
    it('CE11/N44 unbound plain rows cannot be serialized', () => {
        const plan = syntheticRunManifest();
        expect(() => buildLocatorArtifact({ sourceBoundResults: [{ resolved: [], unresolved: [] }], plan, runMetadata: syntheticRunMetadata(plan) })).toThrow(/UNBOUND_ROWS_REJECTED/);
    });
    it('brand factory/token are not importable by artifact-builder callers', async () => {
        const mod = await import('../../scripts/rc3b-audit/locator-source-binding.mjs');
        expect(Object.keys(mod)).not.toContain('SOURCE_BOUND');
        expect(Object.keys(mod)).not.toContain('mint');
        expect(Object.keys(mod)).not.toContain('brandToken');
    });
    it('artifact group rows conform exactly to the committed closed schema', async () => {
        const s = clientScenario(); const bound = await s.client.getLocatorScalars('synthetic/prefix/manifest.json');
        const built = buildLocatorArtifact({ sourceBoundResults: [bound], plan: s.plan, runMetadata: syntheticRunMetadata(s.plan) });
        expect(built.schema.valid).toBe(true);
        const allowed = Object.keys(loadLocatorArtifactSchema().$defs.object_group_result.properties).sort();
        expect(Object.keys(built.artifact.object_group_results[0]).sort()).toEqual(allowed);
    });
    it('CE12/N46 missing cursor/latest diagnostics never return PASS and required specs remain covered', () => {
        const plan = syntheticRunManifest();
        const built = buildLocatorArtifact({ sourceBoundResults: [], objectFailures: [{ source_object_key: 'synthetic/prefix/manifest.json', specs: plan.structural_locator_specs, group_status: 'NOT_FOUND', reason_code: 'OBJECT_NOT_FOUND' }], plan, runMetadata: syntheticRunMetadata(plan) });
        expect(built.artifact.artifact_status).toBe('FAILED');
        expect(built.artifact.object_group_results[0].group_status).toBe('NOT_FOUND');
        expect(built.artifact.unresolved_locators).toHaveLength(5);
    });
    it('missing cursor and parse-failed cursor groups are not PASS; omitted groups cannot vanish', async () => {
        const cursorSpecs = [
            { spec_id: 'CUR_RELEASE', key: 'synthetic/state/cursor.json', field_path: 'release', semantic_type: 'RELEASE_TOKEN', value_pattern_id: 'RELEASE_TOKEN_SEGMENT', scalar_type: 'string', max_utf8_bytes: 64, required: true, pointer_shape: 'cursor_v1', normalization: 'NONE', cross_field_rules: ['RELEASE_TOKEN_SINGLE_SEGMENT'] },
            { spec_id: 'CUR_KEY', key: 'synthetic/state/cursor.json', field_path: 'r2_data_key', semantic_type: 'OBJECT_KEY', value_pattern_id: 'R2_DATA_KEY_PATHSAFE', scalar_type: 'string', max_utf8_bytes: 256, required: true, pointer_shape: 'cursor_v1', normalization: 'NONE', cross_field_rules: ['UMLS_MESH_KEY_EQUALS_RELEASE_PATH'] },
        ];
        const plan = syntheticRunManifest(); plan.structural_locator_specs.push(...cursorSpecs);
        const latest = await clientScenario().client.getLocatorScalars('synthetic/prefix/manifest.json');
        const missing = buildLocatorArtifact({ sourceBoundResults: [latest], objectFailures: [{ source_object_key: 'synthetic/state/cursor.json', specs: cursorSpecs, group_status: 'NOT_FOUND', reason_code: 'OBJECT_NOT_FOUND' }], plan, runMetadata: syntheticRunMetadata(plan) });
        expect(missing.artifact.object_group_results.find((g) => g.source_object_key.endsWith('cursor.json')).group_status).not.toBe('PASS');
        expect(missing.artifact.unresolved_locators.filter((r) => r.source_object_key.endsWith('cursor.json'))).toHaveLength(2);
        const raw = Buffer.from('{broken'); const extracted = extractLocators(raw, cursorSpecs);
        const parsed = verifySourceBinding(raw, extracted, cursorSpecs, { head_etag: 'e', get_etag: 'e', head_content_length: raw.length, get_content_length: raw.length });
        const failed = buildLocatorArtifact({ sourceBoundResults: [latest, parsed], plan, runMetadata: syntheticRunMetadata(plan) });
        expect(failed.artifact.object_group_results.find((g) => g.source_object_key.endsWith('cursor.json')).group_status).toBe('PARSE_FAILED');
        expect(() => buildLocatorArtifact({ sourceBoundResults: [latest], plan, runMetadata: syntheticRunMetadata(plan) })).toThrow(/GROUP_COVERAGE/);
    });
    it('N13 reject-path logs contain no rejected raw locator value', async () => {
        const plan = syntheticRunManifest(); const poison = 'scientific payload prose must never enter logs'; const base = makeSyntheticFakeClient();
        const badBody = Buffer.from(JSON.stringify({ ...JSON.parse(manifestBodyBuffer().toString()), snapshot_date: poison }));
        const fake = { async send(command) {
            if (command?.input?.Key === 'synthetic/prefix/manifest.json' && command.constructor.name === 'HeadObjectCommand') return { ETag: 'm', ContentLength: badBody.length };
            if (command?.input?.Key === 'synthetic/prefix/manifest.json' && command.constructor.name === 'GetObjectCommand') return { ETag: 'm', ContentLength: badBody.length, Body: badBody };
            return base.send(command);
        } };
        const run = await runReadOnlyAudit(plan, Buffer.from(JSON.stringify(plan)), { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, clientOverride: fake, templatePolicy: loadTemplatePolicy() });
        expect(run.logLines.join('\n')).not.toContain(poison);
    });
    it('GET_META remains value-free: no normalized scalar/value field enters evidence', () => {
        const plan = syntheticRunManifest(); const budget = new Budget();
        const runResult = { observations: [], followup: [], budget, guard_counters: {}, stop_reasons: ['NONE'], partial: false, logLines: [] };
        const ev = buildEvidenceFromRun(runResult, plan, { run_metadata: syntheticRunMetadata(plan) }).evidence;
        const text = JSON.stringify(ev);
        expect(text).not.toContain('normalized_scalar_value');
        expect(text).not.toContain('resolved_locators');
    });
    it('schema repo copy retains the authoritative byte hash', () => {
        const hash = createHash('sha256').update(fs.readFileSync('scripts/rc3b-audit/locator-artifact-schema.json')).digest('hex');
        expect(hash).toBe('33e65017a28e77c54e2c819ffb1b7238deaed03aa95be09a75e29d9daabc8837');
    });
    it('allpass=false and a broken happy path each terminate the locator self-test nonzero', () => {
        for (const opts of ['{forceFail:true}', '{breakSource:true}']) {
            const source = `import {runLocatorSelfTest} from './scripts/rc3b-audit/self-test.mjs'; const r=await runLocatorSelfTest(${opts}); process.exit(r.ok?0:1);`;
            const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), encoding: 'utf-8' });
            expect(r.status).not.toBe(0);
        }
    });
    it('new production modules and fixtures contain no production bucket/account/endpoint/key tokens', () => {
        const paths = [
            'scripts/rc3b-audit/locator-extract.mjs', 'scripts/rc3b-audit/locator-source-binding.mjs',
            'scripts/rc3b-audit/locator-artifact.mjs', 'scripts/rc3b-audit/verify-artifact.mjs',
            'scripts/rc3b-audit/template-policy.json', 'scripts/rc3b-audit/fixtures/synthetic-run-manifest.example.json',
        ];
        const joined = paths.map((p) => fs.readFileSync(p, 'utf-8')).join('\n').toLowerCase();
        for (const forbidden of ['sciweon-prod', 'cloudflare.com/client/v4/accounts/', 'snapshots/latest.json', 'state/umls-mesh-bulk-cursor.json']) expect(joined).not.toContain(forbidden);
    });
});
