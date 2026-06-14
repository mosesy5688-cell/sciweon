/**
 * P-8 R1 -- entry / orchestration for the STRICTLY READ-ONLY R2 probe.
 *
 * Builds the REAL R2 S3Client (the SAME makeR2Client the producer uses), wraps
 * it in the probe's OWN read-only guard, runs PART 1 (aggregate prefix
 * inventory) + PART 2 (production latest identity), writes the evidence JSON,
 * prints the [P8R1-PROBE] summary line, and exits non-zero when probe_pass is
 * false. It NEVER writes R2 / changes latest / purges cache: the guard refuses
 * any non-read command (put_count / delete_count / write_attempt_count MUST be
 * 0 for a pass). Dispatch inputs (run id + expected latest identity) are read
 * from env and PASSED IN to the lib -- never hardcoded in the logic.
 */

import fs from 'fs/promises';
import path from 'path';
import { makeR2Client } from '../factory/lib/r2-stage-bridge.js';
import {
    instrumentReadOnlyClient, runAggregateInventory, runLatestIdentity,
    computeProbePass, aggregatePrefix,
} from './p8-r1-readonly-probe-lib.js';

// Dispatch input defaults (the workflow yml exposes these; env overrides).
const DEFAULT_RUN_ID = '27494573900';
const DEFAULT_SNAPSHOT_ID = '2026-06-14/27489690948-1';
const DEFAULT_PAYLOAD_SHA256 = '4f3ab48ca8c289dff3572d3918c06d4617001543cd84a79bc12717de59d6a40c';
const DEFAULT_MANIFEST_HASH = 'f37a02b8f63472449e8c78001931f336aaa187c831a34d23a95c93d9d088368d';

function buildEvidence(runId, expected, part1, part2, verdict) {
    return {
        probe: 'P-8R1',
        generated_at: new Date().toISOString(),
        aggregated_run_id: runId,
        aggregate_prefix: aggregatePrefix(runId),
        expected_file_count: part1.expected_file_count,
        actual_file_count: part1.actual_file_count,
        aggregate_files: part1.aggregate_files,
        control_sidecars: part1.control_sidecars,
        per_object_inventory: part1.per_object_inventory,
        object_count: part1.object_count,
        total_size: part1.total_size,
        aggregate_inventory_hash: part1.aggregate_inventory_hash,
        policy_sidecar_sha256: part1.policy_sidecar_sha256,
        policy_fields: part1.policy_fields,
        unexpected_objects: part1.unexpected_objects,
        missing_files: part1.missing_files,
        part1_assertions: part1.assertions,
        production_latest_key: part2.production_latest_key,
        production_latest_etag: part2.production_latest_etag,
        production_latest_size: part2.production_latest_size,
        production_snapshot_id: part2.production_snapshot_id,
        production_payload_sha256: part2.production_payload_sha256,
        production_manifest_hash: part2.production_manifest_hash,
        production_layout_version: part2.production_layout_version,
        latest_parse_error: part2.parse_error,
        part2_assertions: part2.assertions,
        expected_snapshot_id: expected.snapshot_id,
        expected_payload_sha256: expected.payload_sha256,
        expected_manifest_hash: expected.manifest_hash,
        read_command_counts: verdict.read_command_counts,
        put_count: verdict.put_count,
        delete_count: verdict.delete_count,
        write_attempt_count: verdict.write_attempt_count,
        read_only_clean: verdict.read_only_clean,
        probe_pass: verdict.probe_pass,
    };
}

async function main() {
    const bucket = process.env.R2_BUCKET;
    if (!bucket) throw new Error('R2_BUCKET not set');
    const runId = process.env.AGGREGATED_RUN_ID || DEFAULT_RUN_ID;
    const expected = {
        snapshot_id: process.env.EXPECTED_SNAPSHOT_ID || DEFAULT_SNAPSHOT_ID,
        payload_sha256: process.env.EXPECTED_PAYLOAD_SHA256 || DEFAULT_PAYLOAD_SHA256,
        manifest_hash: process.env.EXPECTED_MANIFEST_HASH || DEFAULT_MANIFEST_HASH,
    };

    const client = instrumentReadOnlyClient(makeR2Client());

    let part1, part2, verdict, fatal = null;
    try {
        part1 = await runAggregateInventory(client, bucket, runId);
        part2 = await runLatestIdentity(client, bucket, expected);
        verdict = computeProbePass(part1, part2, client);
    } catch (err) {
        fatal = String(err?.stack ?? err);
    }

    if (fatal) {
        // Even on a fatal error, emit what we have: the read-only counts are the
        // safety-critical fact (the guard must have let NOTHING write).
        const safe1 = part1 || { expected_file_count: 0, actual_file_count: 0, aggregate_files: 0, control_sidecars: 0, per_object_inventory: [], object_count: 0, total_size: 0, aggregate_inventory_hash: null, policy_sidecar_sha256: null, policy_fields: null, unexpected_objects: [], missing_files: [], assertions: {} };
        const safe2 = part2 || { production_latest_key: 'snapshots/latest.json', production_latest_etag: null, production_latest_size: 0, production_snapshot_id: null, production_payload_sha256: null, production_manifest_hash: null, production_layout_version: null, parse_error: null, assertions: {} };
        const v = computeProbePass(safe1, safe2, client);
        v.probe_pass = false;
        const ev = buildEvidence(runId, expected, safe1, safe2, v);
        ev.fatal_error = fatal;
        await writeEvidence(ev);
        console.error(`[P8R1-PROBE] FATAL: ${fatal}`);
        console.log(`[P8R1-PROBE] probe_pass=false put_count=${v.put_count} delete_count=${v.delete_count} write_attempt_count=${v.write_attempt_count} (fatal error -- see evidence)`);
        process.exit(1);
    }

    const ev = buildEvidence(runId, expected, part1, part2, verdict);
    await writeEvidence(ev);
    console.log(`[P8R1-PROBE] probe_pass=${verdict.probe_pass} aggregate_files=${part1.aggregate_files}/${part1.expected_file_count} control_sidecars=${part1.control_sidecars} unexpected=${part1.unexpected_objects.length} latest_layout=${part2.production_layout_version} put_count=${verdict.put_count} delete_count=${verdict.delete_count} write_attempt_count=${verdict.write_attempt_count} reads=${JSON.stringify(verdict.read_command_counts)}`);
    if (!verdict.probe_pass) process.exit(1);
}

async function writeEvidence(ev) {
    const outDir = process.env.P8R1_OUTPUT_DIR || '.';
    await fs.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, 'p8-r1-readonly-evidence.json');
    await fs.writeFile(out, JSON.stringify(ev, null, 2), 'utf-8');
    console.log(`[P8R1-PROBE] evidence written: ${out}`);
}

main().catch(err => {
    console.error(`[P8R1-PROBE] UNHANDLED: ${String(err?.stack ?? err)}`);
    process.exit(1);
});
