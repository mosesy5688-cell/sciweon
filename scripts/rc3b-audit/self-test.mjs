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
import { runReadOnlyAudit } from './harness.mjs';
import { buildEvidenceFromRun } from './evidence-assembly.mjs';
import { runLeakScan } from './leak-scanner.mjs';

export const SYNTHETIC_BUCKET = 'rc3b-synthetic-bucket';
export const SYNTHETIC_ALLOWED_BUCKETS = Object.freeze([SYNTHETIC_BUCKET]);
const PREFIX = 'synthetic/prefix/';
const MANIFEST_KEY = `${PREFIX}manifest.json`;
const PAYLOAD_KEY = `${PREFIX}data.jsonl.gz`;
const SHARD_KEY = `${PREFIX}fused-shard-000.bin`;

export function manifestBodyBuffer() {
    return Buffer.from(JSON.stringify({
        snapshot_id: '2026-01-01/1-1', object_prefix: PREFIX, manifest_hash: 'b'.repeat(64),
        layout_version: 'immutable_snapshot_v2', schema_version: 1,
        files: [{ filename: 'data.jsonl.gz', records: 10, sha256_compressed: 'c'.repeat(64) }],
    }), 'utf-8');
}

export function syntheticRunManifest() {
    const plan = {
        bucket: SYNTHETIC_BUCKET, endpoint_or_account_binding: 'synthetic-account',
        exact_prefixes: [PREFIX], structural_keys: [MANIFEST_KEY], class_c_head_keys: [PAYLOAD_KEY],
        class_x_targets: [{ key: SHARD_KEY, offset: 0, length: 64, object_class: 'NXVF_SHARD' }],
        object_class_map: { [MANIFEST_KEY]: 'STRUCTURAL_JSON', [PAYLOAD_KEY]: 'MONOLITHIC_GZIP', [SHARD_KEY]: 'NXVF_SHARD' },
        allowed_object_classes: ['STRUCTURAL_JSON', 'NXVF_SHARD', 'MONOLITHIC_GZIP', 'PAYLOAD_JSONL'],
        snapshot_ids: ['2026-01-01/1-1'], caps: {}, template_allowlist_sha256: 'a'.repeat(64),
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
        bucket: plan.bucket, r2_endpoint_or_account_id: plan.endpoint_or_account_binding,
        workflow_run_id: 'synthetic-selftest', commit_sha: 'a'.repeat(40), tag_or_ref: 'refs/heads/rc3b-p0b-readonly-audit-harness',
        materialized_run_plan_sha256: plan.materialized_run_plan_sha256, template_allowlist_sha256: plan.template_allowlist_sha256,
        materialized_allowlist_sha256: plan.materialized_allowlist_sha256, mode: 'READ-ONLY-R2', status: 'PARTIAL',
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
                if (i.Key === MANIFEST_KEY && !i.Range) return { ETag: '"m"', Body: manifest };
                if (i.Key === SHARD_KEY && i.Range) return { ETag: '"s"', Body: shard };
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
