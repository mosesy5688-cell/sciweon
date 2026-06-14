/**
 * P-8 R1 -- STRICTLY READ-ONLY R2 verification probe (pure logic + the
 * read-only WRITE-GUARD). NO process exit, NO top-level I/O: unit-testable with
 * a mock S3 client + canned List/Head/Get responses.
 *
 * READ-ONLY CONTRACT: only ListObjectsV2 / HeadObject / GetObject are ever
 * issued. instrumentReadOnlyClient inspects EVERY command BEFORE it reaches R2;
 * anything not in the ALLOWED read set (default-deny) increments a counter and
 * THROWS -- it never reaches the store. Pass requires put_count == 0 &&
 * delete_count == 0 && write_attempt_count == 0.
 *
 * Two parts: (1) aggregate prefix inventory (22 AGGREGATED_FILES + the
 * _publish_policy.json control sidecar under processed/aggregated/<run_id>/),
 * (2) production snapshots/latest.json identity reconciled vs the dispatch
 * INPUT expected values (parsed with the reader's OWN parseSnapshotContext).
 */

import { createHash } from 'crypto';
import {
    ListObjectsV2Command, HeadObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { parseSnapshotContext } from '../../src/worker/lib/snapshot-context.ts';
import { AGGREGATED_FILES } from '../factory/lib/aggregated-files.js';

export const PROD_LATEST_KEY = 'snapshots/latest.json';
export const POLICY_SIDECAR = '_publish_policy.json';
export const EXPECTED_FILE_COUNT = 22;

export function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }

export async function streamToBuffer(body) {
    if (body == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    const chunks = [];
    for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
}

export function aggregatePrefix(runId) { return `processed/aggregated/${runId}/`; }

export function basename(key) {
    const i = key.lastIndexOf('/');
    return i === -1 ? key : key.slice(i + 1);
}

// -- the READ-ONLY write-GUARD (probe's OWN: List is ALLOWED, unlike V3-C) -----

// ALLOWED read commands pass through. Anything else is refused (default-deny);
// PUT/DELETE sets only feed the per-kind counters.
const ALLOWED = new Set(['ListObjectsV2Command', 'HeadObjectCommand', 'GetObjectCommand']);
const PUT_COMMANDS = new Set(['PutObjectCommand']);
const DELETE_COMMANDS = new Set(['DeleteObjectCommand', 'DeleteObjectsCommand']);

/**
 * Wrap `client.send` so EVERY command is inspected BEFORE it reaches R2. Only
 * the ALLOWED read commands pass; everything else increments the matching
 * counter FIRST then THROWS (never hitting the store). Exposes put_count /
 * delete_count / write_attempt_count + read counts {list,head,get}.
 */
export function instrumentReadOnlyClient(realClient) {
    const log = [];
    const state = { put: 0, delete: 0, writeAttempt: 0, list: 0, head: 0, get: 0 };
    return {
        sendLog: log,
        get callCount() { return log.length; },
        get put_count() { return state.put; },
        get delete_count() { return state.delete; },
        get write_attempt_count() { return state.writeAttempt; },
        get readCounts() { return { list: state.list, head: state.head, get: state.get }; },
        async send(command, ...rest) {
            const ctorName = command?.constructor?.name ?? 'UnknownCommand';
            if (!ALLOWED.has(ctorName)) {
                // count BEFORE throwing so a post-mortem audit always sees it.
                state.writeAttempt += 1;
                if (PUT_COMMANDS.has(ctorName)) state.put += 1;
                if (DELETE_COMMANDS.has(ctorName)) state.delete += 1;
                throw new Error(`[P8R1 READ-ONLY GUARD] refusing a non-read command (${ctorName}) -- the probe is strictly read-only (ListObjectsV2 / HeadObject / GetObject only): no Put / Delete / Copy / Multipart`);
            }
            if (ctorName === 'ListObjectsV2Command') state.list += 1;
            else if (ctorName === 'HeadObjectCommand') state.head += 1;
            else if (ctorName === 'GetObjectCommand') state.get += 1;
            const entry = { seq: log.length + 1, command: ctorName, key: command?.input?.Key ?? command?.input?.Prefix ?? null };
            log.push(entry);
            try {
                const res = await realClient.send(command, ...rest);
                entry.ok = true;
                return res;
            } catch (err) {
                entry.ok = false;
                entry.errorName = err?.name ?? null;
                entry.httpStatus = err?.$metadata?.httpStatusCode ?? null;
                throw err;
            }
        },
    };
}

// -- read-only R2 primitives ---------------------------------------------------

function isoOrNull(d) { return d ? new Date(d).toISOString() : null; }

export async function listAll(client, bucket, prefix) {
    const objects = [];
    let token;
    do {
        const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
        for (const o of r.Contents || []) objects.push({ key: o.Key, size: o.Size ?? 0, etag: o.ETag ?? null, last_modified: isoOrNull(o.LastModified) });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return objects;
}

export async function headObject(client, bucket, key) {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { etag: res.ETag ?? null, size: res.ContentLength ?? res.Size ?? 0, last_modified: isoOrNull(res.LastModified) };
}

export async function getObject(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(res.Body);
    return { etag: res.ETag ?? null, size: body.length, body };
}

// -- inventory hash (deterministic, order-independent) + drift guard -----------

export function aggregateInventoryHash(inventory) {
    const lines = inventory.map(o => `${o.key}\t${o.size}\t${o.etag}`).sort();
    return sha256Hex(Buffer.from(lines.join('\n'), 'utf-8'));
}

export function assertAggregatedFilesLength(files = AGGREGATED_FILES) {
    if (files.length !== EXPECTED_FILE_COUNT) {
        throw new Error(`[P8R1] AGGREGATED_FILES length drift: expected ${EXPECTED_FILE_COUNT}, got ${files.length} -- SSoT changed; probe must be re-pinned, never silently accept`);
    }
    return files.length;
}

// -- PART 1: aggregate prefix inventory ---------------------------------------

// List the exact aggregate prefix, HEAD each object, GET the policy sidecar;
// build the inventory + order-independent hash + policy fields + assertions.
export async function runAggregateInventory(client, bucket, runId, files = AGGREGATED_FILES) {
    assertAggregatedFilesLength(files);
    const prefix = aggregatePrefix(runId);
    const listed = await listAll(client, bucket, prefix);

    const per_object_inventory = [];
    for (const o of listed) {
        const h = await headObject(client, bucket, o.key);
        per_object_inventory.push({ key: o.key, size: h.size, etag: h.etag, last_modified: h.last_modified });
    }
    const object_count = per_object_inventory.length;
    const total_size = per_object_inventory.reduce((a, o) => a + (o.size || 0), 0);
    const aggregate_inventory_hash = aggregateInventoryHash(per_object_inventory);

    const basenames = new Set(per_object_inventory.map(o => basename(o.key)));
    const allowedBasenames = new Set([...files, POLICY_SIDECAR]);

    const aggregate_files = files.filter(f => basenames.has(f)).length;
    const missing_files = files.filter(f => !basenames.has(f));
    const all_aggregate_files_present = missing_files.length === 0;
    const policy_present = basenames.has(POLICY_SIDECAR);
    const control_sidecars = policy_present ? 1 : 0;
    const unexpected_objects = per_object_inventory
        .map(o => o.key)
        .filter(k => !allowedBasenames.has(basename(k)));

    let policy_sidecar_sha256 = null, policy_fields = null;
    let policy_publication_policy_ok = false, policy_mode_ok = false, policy_run_id_ok = false;
    if (policy_present) {
        const g = await getObject(client, bucket, `${prefix}${POLICY_SIDECAR}`);
        policy_sidecar_sha256 = sha256Hex(g.body);
        try {
            const parsed = JSON.parse(g.body.toString('utf-8'));
            policy_fields = parsed;
            policy_publication_policy_ok = parsed.publication_policy === 'MANUAL_ONLY';
            policy_mode_ok = parsed.mode === 'backfill_only';
            policy_run_id_ok = String(parsed.aggregated_run_id) === String(runId);
        } catch (err) { policy_fields = { _parse_error: String(err?.message ?? err) }; }
    }

    const part1_pass = all_aggregate_files_present
        && policy_present
        && policy_publication_policy_ok && policy_mode_ok && policy_run_id_ok
        && unexpected_objects.length === 0;

    return {
        aggregate_prefix: prefix, expected_file_count: files.length,
        actual_file_count: object_count, aggregate_files, control_sidecars,
        per_object_inventory, object_count, total_size, aggregate_inventory_hash,
        policy_sidecar_sha256, policy_fields, unexpected_objects, missing_files,
        assertions: {
            all_aggregate_files_present, policy_present,
            policy_publication_policy_ok, policy_mode_ok, policy_run_id_ok,
            no_unexpected_objects: unexpected_objects.length === 0,
        },
        part1_pass,
    };
}

// -- PART 2: production latest identity (latest GET EXACTLY ONCE) --------------

// HEAD + a SINGLE GET of snapshots/latest.json; the SAME raw GET bytes feed
// raw_sha256 + parseSnapshotContext + reconcile vs the INPUT expected values
// (passed in). A legacy_v1 / unparseable latest is a HARD FAIL.
export async function runLatestIdentity(client, bucket, expected) {
    const head = await headObject(client, bucket, PROD_LATEST_KEY);
    const g = await getObject(client, bucket, PROD_LATEST_KEY); // EXACTLY ONCE.
    const raw_sha256 = sha256Hex(g.body);

    let ctx = null, parse_error = null;
    try { ctx = parseSnapshotContext(g.body.toString('utf-8')); }
    catch (err) { parse_error = String(err?.message ?? err); }

    const layout_version = ctx?.layout_version ?? null;
    const snapshot_id = ctx?.snapshot_id ?? null;
    const manifest_hash = ctx?.manifest_hash ?? null;
    const is_v2 = layout_version === 'immutable_snapshot_v2';
    const snapshot_id_match = snapshot_id === expected.snapshot_id;
    const payload_sha256_match = raw_sha256 === expected.payload_sha256;
    const manifest_hash_match = manifest_hash === expected.manifest_hash;
    const part2_pass = ctx != null && is_v2 && snapshot_id_match && payload_sha256_match && manifest_hash_match;

    return {
        production_latest_key: PROD_LATEST_KEY, production_latest_etag: head.etag,
        production_latest_size: head.size, production_snapshot_id: snapshot_id,
        production_payload_sha256: raw_sha256, production_manifest_hash: manifest_hash,
        production_layout_version: layout_version, parse_error,
        assertions: { is_immutable_v2: is_v2, snapshot_id_match, payload_sha256_match, manifest_hash_match },
        part2_pass,
    };
}

// -- combined probe verdict ----------------------------------------------------

export function computeProbePass(part1, part2, client) {
    const put = client?.put_count ?? 0;
    const del = client?.delete_count ?? 0;
    const wa = client?.write_attempt_count ?? 0;
    const read_only_clean = put === 0 && del === 0 && wa === 0;
    return {
        probe_pass: Boolean(part1?.part1_pass && part2?.part2_pass && read_only_clean),
        put_count: put,
        delete_count: del,
        write_attempt_count: wa,
        read_command_counts: client?.readCounts ?? { list: 0, head: 0, get: 0 },
        read_only_clean,
    };
}
