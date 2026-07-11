/**
 * RC-3B-P0B -- evidence artifact builder (structurally free-text-incapable).
 *
 * Every field is a locator, an enumerated token, a count, a size, a hash, or a
 * committed field-path name. There is NO code path that copies a payload value
 * into the artifact: buildInventoryRecord assembles a FIXED key set from
 * controlled inputs; observed_field_paths are filtered through a COMMITTED
 * field-path allowlist (anything not on the list is dropped). Hashes are
 * finalized last: artifact_sha256 is the hash of the artifact with that one
 * field excluded, so it is recomputable by any verifier.
 */

import { createHash } from 'crypto';
import { logBundleSha256 } from './log-bundle.mjs';

// The committed canonical field-path allowlist (locators of shape, not content).
export const FIELD_PATH_ALLOWLIST = Object.freeze([
    'snapshot_id', 'object_prefix', 'manifest_hash', 'layout_version',
    'schema_version', 'files', 'files[].filename', 'files[].records',
    'files[].sha256_compressed', 'required_inventory', 'satellite_inventory',
    'compound_shard_hashes', 'run_id',
]);

function sha256Hex(str) { return createHash('sha256').update(Buffer.from(str, 'utf-8')).digest('hex'); }

export function buildOperationEvidence(budget, counters) {
    const c = budget.counters;
    return {
        list_pages: c.listPages,
        list_keys_returned: c.listKeys,
        head_requests: c.headRequests,
        get_meta_requests: c.getMetaRequests,
        range_requests: c.rangeRequests,
        bytes_get_meta: c.bytesGetMeta,
        bytes_range: c.bytesRange,
        rejected_before_network: c.rejectedBeforeNetwork,
        attempts_after_stop: counters ? counters.attempts_after_stop : 0,
        network_calls_after_stop: counters ? counters.network_calls_after_stop : 0,
        unexpected_command_count: counters ? counters.unexpected_command_count : 0,
    };
}

export function sanitizeFieldPaths(paths = [], allowlist = FIELD_PATH_ALLOWLIST) {
    const allow = new Set(allowlist);
    return paths.filter((p) => allow.has(p));
}

/**
 * Build ONE inventory record from controlled inputs. `spec` supplies enumerated
 * classifications + a locator object_key + counts/hashes ONLY. An optional
 * `sample` attaches a targeted_sample; its observed_field_paths are filtered
 * against the committed allowlist. No free-text field is ever produced.
 */
export function buildInventoryRecord(spec) {
    const rec = {
        source_family: spec.source_family,
        content_class: spec.content_class,
        field_group: spec.field_group,
        actual_ingested_distribution: spec.actual_ingested_distribution,
        snapshot_id: spec.snapshot_id,
        object_key: spec.object_key,
        object_type: spec.object_type,
        active_or_historical: spec.active_or_historical,
        backup_or_export: spec.backup_or_export,
        physical_presence: spec.physical_presence,
        served_reference: spec.served_reference,
        byte_or_record_count: Number.isInteger(spec.byte_or_record_count) ? spec.byte_or_record_count : -1,
        hash_or_etag: spec.hash_or_etag == null ? '' : String(spec.hash_or_etag),
        physical_evidence_classes: spec.physical_evidence_classes,
        rights_evidence_class: spec.rights_evidence_class,
        rights_class: spec.rights_class,
        territory_scope: spec.territory_scope,
        recommended_disposition: spec.recommended_disposition,
    };
    if (spec.sample) {
        const s = spec.sample;
        const sample = { sample_kind: s.sample_kind };
        if (s.observed_field_paths) sample.observed_field_paths = sanitizeFieldPaths(s.observed_field_paths);
        if (s.shape_signature_sha256) sample.shape_signature_sha256 = s.shape_signature_sha256;
        if (Number.isInteger(s.sample_bytes_read)) sample.sample_bytes_read = s.sample_bytes_read;
        if (Number.isInteger(s.sample_decoded_bytes)) sample.sample_decoded_bytes = s.sample_decoded_bytes;
        rec.targeted_sample = sample;
    }
    return rec;
}

/**
 * Assemble the full artifact, run the provided leak-scan results into
 * integrity_evidence, then finalize log + artifact hashes.
 *
 * @param {object} a  { run_metadata, operation_evidence, inventory_records,
 *                      followup_queue, scanResult, logLines }
 * @returns {object} the finalized, schema-shaped evidence artifact
 */
export function assembleAndFinalize(a) {
    const evidence = {
        run_metadata: a.run_metadata,
        operation_evidence: a.operation_evidence,
        integrity_evidence: {
            artifact_sha256: '0'.repeat(64),
            // Hash over the SAME bytes serializeLogBundle writes to the log file,
            // so an external verifier can rehash the file and compare.
            log_bundle_sha256: logBundleSha256(a.logLines || []),
            leak_scanner_name: a.scanResult.leak_scanner_name,
            leak_scanner_version: a.scanResult.leak_scanner_version,
            leak_policy_sha256: a.scanResult.leak_policy_sha256,
            artifact_scan_result: a.scanResult.artifact_scan_result,
            log_scan_result: a.scanResult.log_scan_result,
            forbidden_property_scan_result: a.scanResult.forbidden_property_scan_result,
        },
        inventory_records: a.inventory_records || [],
        followup_queue: a.followup_queue || [],
    };
    const forHash = JSON.parse(JSON.stringify(evidence));
    delete forHash.integrity_evidence.artifact_sha256;
    evidence.integrity_evidence.artifact_sha256 = sha256Hex(JSON.stringify(forHash));
    return evidence;
}

/** Recompute the artifact_sha256 the way a verifier does (field excluded). */
export function recomputeArtifactSha256(evidence) {
    const clone = JSON.parse(JSON.stringify(evidence));
    delete clone.integrity_evidence.artifact_sha256;
    return sha256Hex(JSON.stringify(clone));
}
