/**
 * RC-3B-P0B -- OFFLINE self-test + synthetic fixtures (ZERO network).
 *
 * Provides a fully-materialized SYNTHETIC run manifest (with recomputed
 * integrity hashes), a fake in-memory client that serves canned List/Head/Get
 * responses, and runSelfTest(): it drives the real harness end-to-end against
 * the fake, asserts the evidence validates against the byte-identical schema,
 * proves the leak scan PASSES on the clean artifact (positive control) and
 * FAILS on a poisoned one (negative control), and confirms no post-stop /
 * unexpected network. The workflow runs this with NO secrets and NO R2 access.
 */

import { validateRunManifest } from './run-manifest.mjs';
import { allowlistSha256, runPlanSha256 } from './manifest-hash.mjs';
import { templatePolicyCanonicalSha256, loadTemplatePolicy } from './template-policy.mjs';
import { deriveEndpointBinding } from './endpoint-binding.mjs';
import { runReadOnlyAudit } from './harness.mjs';
import { buildEvidenceFromRun } from './evidence-assembly.mjs';
import { runLeakScan } from './leak-scanner.mjs';
import { buildLocatorArtifact } from './locator-artifact.mjs';
import { verifyLocatorArtifact } from './verify-artifact.mjs';

export const SYNTHETIC_BUCKET = 'rc3b-synthetic-bucket';
export const SYNTHETIC_ALLOWED_BUCKETS = Object.freeze([SYNTHETIC_BUCKET]);
// The synthetic account id whose derived endpoint binding the fixture/template
// carry; assertEndpointBinding(env, plan) passes when R2_ACCOUNT_ID == this.
export const SYNTHETIC_ACCOUNT_ID = 'synthetic-account-id';
export const SYNTHETIC_ENDPOINT_BINDING = deriveEndpointBinding(SYNTHETIC_ACCOUNT_ID);
const PREFIX = 'synthetic/prefix/';
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const PAYLOAD_KEY = `${PREFIX}data.jsonl.gz`;
const SHARD_KEY = `${PREFIX}fused-shard-000.bin`;
const SNAPSHOT_DATE = '2026-01-01';
const SNAPSHOT_ID = `${SNAPSHOT_DATE}/1-1`;
const OBJECT_PREFIX = `snapshots/${SNAPSHOT_ID}/`;

export function syntheticLocatorSpecs() {
    const common = { key: MANIFEST_KEY, required: true, pointer_shape: 'immutable_snapshot_v2' };
    return [
        { ...common, spec_id: 'SYN_LAYOUT_VERSION', field_path: 'layout_version', semantic_type: 'LAYOUT_VERSION', scalar_type: 'string', value_pattern_id: 'LAYOUT_VERSION_V2', normalization: 'NONE', max_utf8_bytes: 64, cross_field_rules: ['LAYOUT_SELECTS_SPEC_SET'] },
        { ...common, spec_id: 'SYN_SNAPSHOT_DATE', field_path: 'snapshot_date', semantic_type: 'SNAPSHOT_DATE', scalar_type: 'string', value_pattern_id: 'ISO_DATE', normalization: 'NONE', max_utf8_bytes: 10, cross_field_rules: [] },
        { ...common, spec_id: 'SYN_SNAPSHOT_ID', field_path: 'snapshot_id', semantic_type: 'SNAPSHOT_ID', scalar_type: 'string', value_pattern_id: 'SNAPSHOT_ID_V2', normalization: 'NONE', max_utf8_bytes: 64, cross_field_rules: ['SNAPSHOT_ID_MATCHES_IMMUTABLE_IDENTITY'] },
        { ...common, spec_id: 'SYN_OBJECT_PREFIX', field_path: 'object_prefix', semantic_type: 'OBJECT_PREFIX', scalar_type: 'string', value_pattern_id: 'OBJECT_PREFIX_V2', normalization: 'ENSURE_TRAILING_SLASH', max_utf8_bytes: 128, cross_field_rules: ['OBJECT_PREFIX_EQUALS_SNAPSHOTS_PLUS_ID', 'OBJECT_PREFIX_STARTS_SNAPSHOTS_ENDS_SLASH', 'PATH_SEGMENTS_SAFE'] },
        { ...common, spec_id: 'SYN_COMPOUNDS_MANIFEST', field_path: 'compounds_manifest_key', semantic_type: 'MANIFEST_KEY', scalar_type: 'string', value_pattern_id: 'MANIFEST_KEY_PATHSAFE', normalization: 'NONE', max_utf8_bytes: 192, cross_field_rules: ['COMPOUNDS_MANIFEST_EQUALS_FIXED_SUFFIX', 'MANIFEST_KEY_UNDER_OBJECT_PREFIX', 'PATH_SEGMENTS_SAFE'] },
    ];
}

export function manifestBodyBuffer() {
    return Buffer.from(JSON.stringify({
        snapshot_date: SNAPSHOT_DATE, snapshot_id: SNAPSHOT_ID, object_prefix: OBJECT_PREFIX,
        compounds_manifest_key: `${OBJECT_PREFIX}compounds/bucket-0000/manifest.json`, manifest_hash: 'b'.repeat(64),
        layout_version: 'immutable_snapshot_v2', schema_version: 1,
        files: [{ filename: 'data.jsonl.gz', records: 10, sha256_compressed: 'c'.repeat(64) }],
    }), 'utf-8');
}

export function syntheticRunManifest() {
    const plan = {
        plan_version: '0.1.0',
        bucket: SYNTHETIC_BUCKET, endpoint_or_account_binding: SYNTHETIC_ENDPOINT_BINDING,
        exact_prefixes: [PREFIX], structural_keys: [MANIFEST_KEY], class_c_head_keys: [PAYLOAD_KEY],
        class_x_targets: [{ key: SHARD_KEY, offset: 0, length: 64, object_class: 'NXVF_SHARD' }],
        object_class_map: { [MANIFEST_KEY]: 'STRUCTURAL_JSON', [PAYLOAD_KEY]: 'MONOLITHIC_GZIP', [SHARD_KEY]: 'NXVF_SHARD' },
        allowed_object_classes: ['STRUCTURAL_JSON', 'NXVF_SHARD', 'MONOLITHIC_GZIP', 'PAYLOAD_JSONL'],
        snapshot_ids: ['2026-01-01/1-1'], caps: {},
        structural_locator_specs: syntheticLocatorSpecs(),
        record_spec_ref: 'rc3b-p0b-record-spec-v0',
        authorized_binding: { account_binding: SYNTHETIC_ACCOUNT_ID },
        template_allowlist_sha256: templatePolicyCanonicalSha256(),
    };
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    return plan;
}

export function syntheticRecordSpecs() {
    const meta = {
        source_family: 'SYNTHETIC-FAMILY', content_class: 'STRUCTURAL-METADATA', field_group: 'MANIFEST',
        actual_ingested_distribution: 'SYNTHETIC-DIST', active_or_historical: 'historical', backup_or_export: 'none',
        served_reference: 'not-served', rights_evidence_class: 'PM-PROPOSED', rights_class: 'METADATA-ONLY',
        territory_scope: 'GLOBAL', recommended_disposition: 'KEEP-WITH-LICENSE-ENVELOPE', snapshot_id: '2026-01-01/1-1',
    };
    return { [MANIFEST_KEY]: { ...meta, object_type: 'shard-manifest' }, [SHARD_KEY]: { ...meta, object_type: 'shard' }, [PAYLOAD_KEY]: { ...meta, object_type: 'export' } };
}

export function syntheticRunMetadata(plan) {
    return {
        bucket: plan.bucket,
        // CHANGE C: the endpoint evidence is the COMPUTED 64-hex binding (== observed).
        r2_endpoint_or_account_binding: plan.endpoint_or_account_binding,
        carrier_tag: 'rc3b-p0b-carrier-synthetic',
        // C1A-R1 / B4: READ-ONLY-R2 metadata is DIGITS-ONLY run id + attempt 1 +
        // a refs/tags ref, so the offline self-test stays schema-valid.
        workflow_run_id: '4200000042', workflow_run_attempt: 1,
        commit_sha: 'a'.repeat(40), tag_or_ref: 'refs/tags/rc3b-p0b-carrier-synthetic',
        materialized_run_plan_sha256: plan.materialized_run_plan_sha256, template_allowlist_sha256: plan.template_allowlist_sha256,
        materialized_allowlist_sha256: plan.materialized_allowlist_sha256,
        authorized_harness_sha: 'a'.repeat(40), authorized_run_plan_sha256: 'a'.repeat(64), authorized_template_file_sha256: 'a'.repeat(64),
        authorized_endpoint_or_account_binding: plan.endpoint_or_account_binding,
        observed_endpoint_or_account_binding: plan.endpoint_or_account_binding,
        endpoint_binding_match: 'PASS',
        mode: 'READ-ONLY-R2', status: 'PARTIAL',
    };
}

export function makeSyntheticFakeClient() {
    const manifest = manifestBodyBuffer();
    const shard = Buffer.concat([Buffer.from([0x4e, 0x58, 0x56, 0x46]), Buffer.alloc(60, 1)]);
    return {
        async send(command) {
            const ctor = command?.constructor?.name; const i = command?.input || {};
            if (ctor === 'ListObjectsV2Command') {
                return { IsTruncated: false, Contents: [{ Key: MANIFEST_KEY, Size: manifest.length, ETag: '"m"' }, { Key: SHARD_KEY, Size: 4096, ETag: '"s"' }] };
            }
            if (ctor === 'HeadObjectCommand') {
                if (i.Key === MANIFEST_KEY) return { ETag: '"m"', ContentLength: manifest.length };
                if (i.Key === PAYLOAD_KEY) return { ETag: '"p"', ContentLength: 999999 };
                if (i.Key === SHARD_KEY) return { ETag: '"s"', ContentLength: 4096 };
            }
            if (ctor === 'GetObjectCommand') {
                if (i.Key === MANIFEST_KEY && !i.Range) return { ETag: '"m"', ContentLength: manifest.length, Body: manifest };
                if (i.Key === SHARD_KEY && i.Range) return { ETag: '"s"', ContentRange: 'bytes 0-63/4096', ContentLength: 64, Body: shard };
            }
            throw new Error(`synthetic fake: unhandled ${ctor} ${i.Key || i.Prefix} range=${i.Range || ''}`);
        },
    };
}

export function poisonedEvidence(clean) {
    const p = JSON.parse(JSON.stringify(clean));
    if (p.inventory_records && p.inventory_records.length) {
        p.inventory_records[0].hash_or_etag = 'leaked free text from the object body with spaces';
    }
    return p;
}

export async function runLocatorSelfTest({ forceFail = false, breakSource = false } = {}) {
    const plan = syntheticRunManifest(); const tp = loadTemplatePolicy();
    const base = makeSyntheticFakeClient();
    const client = breakSource ? { async send(command) {
        const r = await base.send(command);
        if (command?.constructor?.name === 'GetObjectCommand' && !command?.input?.Range) return { ...r, ETag: 'different-etag' };
        return r;
    } } : base;
    const run = await runReadOnlyAudit(plan, Buffer.from(JSON.stringify(plan)), {
        allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, clientOverride: client, templatePolicy: tp,
    });
    const metadata = syntheticRunMetadata(plan);
    const evidence = buildEvidenceFromRun(run, plan, { run_metadata: metadata, record_specs: syntheticRecordSpecs() }).evidence;
    const built = buildLocatorArtifact({ sourceBoundResults: run.locator_source_results, objectFailures: run.locator_object_failures, plan, runMetadata: metadata });
    const verified = verifyLocatorArtifact(built.artifact, { plan, templatePolicy: tp, evidence });
    const checks = {
        closed_schema: built.schema.valid,
        verifier_join: verified.ok,
        complete_happy_path: built.artifact.artifact_status === 'COMPLETE',
        one_locator_get: run.budget.counters.getLocatorRequests === 1,
        forced_control: !forceFail,
    };
    return { ok: Object.values(checks).every(Boolean), checks, artifact: built.artifact };
}

export async function runSelfTest() {
    const plan = syntheticRunManifest();
    const admissibility = validateRunManifest(plan, { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS });
    const runResult = await runReadOnlyAudit(plan, Buffer.from(JSON.stringify(plan)), {
        allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, clientOverride: makeSyntheticFakeClient(),
    });
    const built = buildEvidenceFromRun(runResult, plan, {
        run_metadata: syntheticRunMetadata(plan), record_specs: syntheticRecordSpecs(),
    });
    const neg = runLeakScan({ artifact: poisonedEvidence(built.evidence), logLines: [] });
    const checks = {
        manifest_admissible: admissibility.admissible,
        schema_valid: built.schema.valid,
        leak_positive_pass: built.scanResult.pass === true,
        leak_negative_fails: neg.pass === false,
        run_plan_hash_consistent: plan.materialized_run_plan_sha256 === runPlanSha256(plan),
        no_network_after_stop: built.evidence.operation_evidence.network_calls_after_stop === 0,
        unexpected_command_zero: built.evidence.operation_evidence.unexpected_command_count === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    return { ok, checks, schema_errors: built.schema.errors, evidence: built.evidence, scanResult: built.scanResult };
}
