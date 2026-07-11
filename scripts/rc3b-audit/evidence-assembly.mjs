/**
 * RC-3B-P0B -- evidence assembly + schema validation + leak scan (offline).
 *
 * Turns a runReadOnlyAudit() result into a schema-conformant evidence artifact:
 * physical observations become inventory records (merged with the COMMITTED
 * per-object classification spec from the plan; safe UNKNOWN placeholders when a
 * spec is absent -- the harness never fabricates rights facts), then the leak
 * scanner runs (over the free-text-free content), the hashes are finalized, and
 * the artifact is validated against the byte-identical evidence schema.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    buildInventoryRecord, buildOperationEvidence, assembleAndFinalize,
} from './evidence-builder.mjs';
import { runLeakScan } from './leak-scanner.mjs';
import { validateDraft07 } from './schema-validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(HERE, 'evidence-schema.json');

export function loadEvidenceSchema() {
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
}

const OBJECT_TYPE_BY_KIND = { listed: 'other', structural: 'shard-manifest', head: 'other', range: 'shard' };

function defaultSpec() {
    return {
        source_family: 'UNSPECIFIED', content_class: 'UNSPECIFIED', field_group: 'UNSPECIFIED',
        actual_ingested_distribution: 'UNSPECIFIED', active_or_historical: 'unknown',
        backup_or_export: 'unknown', served_reference: 'unknown',
        rights_evidence_class: 'UNKNOWN', rights_class: 'QUARANTINE-PENDING-PROVENANCE',
        territory_scope: 'UNKNOWN', recommended_disposition: 'NEEDS-COUNSEL',
    };
}

function physicalClasses(obs) {
    const base = ['R2-OBSERVED'];
    if (obs.sample) base.push('TARGETED-BYTE-SAMPLED');
    return base;
}

export function mapObservationToRecord(obs, spec, snapshotId) {
    const s = { ...defaultSpec(), ...(spec || {}) };
    return buildInventoryRecord({
        source_family: s.source_family, content_class: s.content_class, field_group: s.field_group,
        actual_ingested_distribution: s.actual_ingested_distribution,
        snapshot_id: s.snapshot_id || snapshotId || 'unknown',
        object_key: obs.object_key,
        object_type: s.object_type || OBJECT_TYPE_BY_KIND[obs.kind] || 'unknown',
        active_or_historical: s.active_or_historical, backup_or_export: s.backup_or_export,
        physical_presence: obs.physical_presence, served_reference: s.served_reference,
        byte_or_record_count: obs.byte_or_record_count,
        hash_or_etag: obs.hash_or_etag == null ? '' : String(obs.hash_or_etag).replace(/"/g, ''),
        physical_evidence_classes: physicalClasses(obs),
        rights_evidence_class: s.rights_evidence_class, rights_class: s.rights_class,
        territory_scope: s.territory_scope, recommended_disposition: s.recommended_disposition,
        sample: obs.sample,
    });
}

/**
 * @param {object} runResult  from runReadOnlyAudit()
 * @param {object} plan        the run manifest
 * @param {object} opts        { run_metadata, record_specs, schema }
 * @returns {{evidence, scanResult, schema:{valid,errors}}}
 */
export function buildEvidenceFromRun(runResult, plan, opts = {}) {
    const specs = opts.record_specs || {};
    const snapshotId = (plan.snapshot_ids && plan.snapshot_ids[0]) || 'unknown';
    const inventory_records = runResult.observations.map((o) => mapObservationToRecord(o, specs[o.object_key], snapshotId));
    const operation_evidence = buildOperationEvidence(runResult.budget, runResult.guard_counters);
    const run_metadata = {
        ...opts.run_metadata,
        stop_reasons: opts.run_metadata.stop_reasons || runResult.stop_reasons,
        partial: opts.run_metadata.partial != null ? opts.run_metadata.partial : runResult.partial,
    };

    // Scan the free-text-free content BEFORE integrity fields exist (no circularity).
    const scanResult = runLeakScan({
        artifact: { run_metadata, operation_evidence, inventory_records, followup_queue: runResult.followup },
        logLines: runResult.logLines,
    });

    const evidence = assembleAndFinalize({
        run_metadata, operation_evidence, inventory_records,
        followup_queue: runResult.followup, scanResult, logLines: runResult.logLines,
    });

    const schema = opts.schema || loadEvidenceSchema();
    const validation = validateDraft07(schema, evidence);
    return { evidence, scanResult, schema: validation };
}
