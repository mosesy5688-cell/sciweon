/**
 * RK-15 PR-B — Immutable snapshot identity + v2 key layout + canonical hash.
 *
 * THE single producer-side source of truth for:
 *   1. the UNIQUE IMMUTABLE snapshot identity (date + GITHUB_RUN_ID +
 *      GITHUB_RUN_ATTEMPT) and its object_prefix;
 *   2. the v2 child-object key layout — REPLICATED here so it is byte-identical
 *      to what the deployed reader derives (src/worker/lib/*). The producer is
 *      Node.js and cannot import the worker TS at runtime; a test
 *      (snapshot-identity-reader-match.test.ts) locks producer == reader;
 *   3. the ONE canonical manifest hash (SHA-256 over sorted-key UTF-8 JSON),
 *      shared by the producer + any verifier, pinned by golden vectors;
 *   4. create-only PUT semantics (R2 conditional IfNoneMatch:'*') + precondition
 *      detection, so every snapshot object is write-once / collision-loud.
 *
 * Reader contract matched (src/worker/lib, parseImmutableV2):
 *   object_prefix              snapshots/<date>/<run_id>-<attempt>/  (ends in /)
 *   compounds_manifest_key     <prefix>compounds/bucket-NNNN/manifest.json
 *     -> reader strips at '/compounds/' -> shards are siblings shard-MMM.bin
 *   neg_evidence_manifest_key  <prefix>neg-evidence/bucket-NNNN/manifest.json
 *     -> reader strips at '/neg-evidence/' -> shards are siblings shard-MMM.bin
 *   xref_index_key             <prefix>xref-index.json.gz
 *   search corpus              <prefix>compounds-search.jsonl.gz  (+ enriched)
 */

import { createHash } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';

// ── Publish state machine (recorded in candidate metadata, not only logs) ──
export const PUBLISH_STATES = Object.freeze({
    BUILDING: 'BUILDING',
    OBJECTS_COMPLETE: 'OBJECTS_COMPLETE',
    VALIDATED: 'VALIDATED',
    ACTIVATABLE: 'ACTIVATABLE',
    ACTIVE: 'ACTIVE',
});

export const LAYOUT_VERSION_V2 = 'immutable_snapshot_v2';
export const SNAPSHOT_SCHEMA_VERSION = 1;
// The snapshot-root seal written LAST (after every data object + the canonical
// manifest). Its presence == OBJECTS_COMPLETE for that prefix.
export const ROOT_SEAL_NAME = '_snapshot.manifest.json';

function pad4(n) { return String(n).padStart(4, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

// ── Identity ───────────────────────────────────────────────────────────────

/** GITHUB_RUN_ID (the run helper analog already in r2-stage-bridge). */
export function deriveRunId() {
    return process.env.GITHUB_RUN_ID
        || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** GITHUB_RUN_ATTEMPT (defaults to 1 for a local/non-Actions run). */
export function deriveRunAttempt() {
    const a = process.env.GITHUB_RUN_ATTEMPT;
    return a && /^\d+$/.test(a) ? a : '1';
}

/** The unique, immutable snapshot_id `<date>/<run_id>-<attempt>`. */
export function deriveSnapshotId(date, runId = deriveRunId(), runAttempt = deriveRunAttempt()) {
    return `${date}/${runId}-${runAttempt}`;
}

/** object_prefix `snapshots/<snapshot_id>/` — ALWAYS ends with `/`. */
export function objectPrefixFor(snapshotId) {
    return `snapshots/${snapshotId}/`;
}

// ── v2 key layout (byte-identical to the reader's derivation) ───────────────

export function compoundsManifestKey(objectPrefix, bucket = 0) {
    return `${objectPrefix}compounds/bucket-${pad4(bucket)}/manifest.json`;
}
export function compoundsShardKey(objectPrefix, bucket, shard) {
    return `${objectPrefix}compounds/bucket-${pad4(bucket)}/shard-${pad3(shard)}.bin`;
}
export function negManifestKey(objectPrefix, bucket = 0) {
    return `${objectPrefix}neg-evidence/bucket-${pad4(bucket)}/manifest.json`;
}
export function negShardKey(objectPrefix, bucket, shard) {
    return `${objectPrefix}neg-evidence/bucket-${pad4(bucket)}/shard-${pad3(shard)}.bin`;
}
/** The neg sentinel pointer the reader normalizes at `/neg-evidence/`. */
export function negEvidenceRootKey(objectPrefix) {
    return `${objectPrefix}neg-evidence/`;
}
export function xrefIndexKey(objectPrefix) {
    return `${objectPrefix}xref-index.json.gz`;
}
export function searchProjectionKey(objectPrefix) {
    return `${objectPrefix}compounds-search.jsonl.gz`;
}
export function enrichedKey(objectPrefix) {
    return `${objectPrefix}compounds-enriched.jsonl.gz`;
}
export function rootSealKey(objectPrefix) {
    return `${objectPrefix}${ROOT_SEAL_NAME}`;
}

// ── Canonical manifest hash (ONE impl, golden-vector pinned) ────────────────

/**
 * Canonical bytes for a manifest/object: deterministic JSON with keys sorted
 * recursively (arrays keep their order — array order is meaningful), UTF-8, NO
 * trailing newline, NO BOM, compact separators (',' / ':'), computed PRE-
 * compression (on the logical object, never the gzip bytes). Exported so the
 * producer + any verifier serialize byte-identically.
 */
export function canonicalize(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        const body = keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',');
        return `{${body}}`;
    }
    // Primitives (incl. null/number/bool/string) via JSON.stringify -> stable.
    return JSON.stringify(value === undefined ? null : value);
}

/** SHA-256 (hex) of the canonical bytes. The ONE hash used everywhere. */
export function canonicalManifestHash(value) {
    return createHash('sha256').update(Buffer.from(canonicalize(value), 'utf-8')).digest('hex');
}

// ── Create-only writes (collision-loud immutability) ────────────────────────

/** True if `err` is an R2/S3 precondition failure (existing object collision). */
export function isPreconditionFailed(err) {
    return err?.name === 'PreconditionFailed'
        || err?.$metadata?.httpStatusCode === 412
        || /precondition/i.test(err?.message ?? '');
}

/** True if R2 rejected the conditional header itself (not a real collision). */
export function isConditionalUnsupported(err) {
    return /not implemented|invalidargument|badrequest|conditional|notimplemented/i.test(err?.message ?? '')
        || err?.$metadata?.httpStatusCode === 400
        || err?.$metadata?.httpStatusCode === 501;
}

/**
 * Create-only PUT: conditional `IfNoneMatch:'*'` so an existing object at `key`
 * fails LOUD (a real collision = re-creating the RK-15 bug). A 412 surfaces as
 * an explicit throw. The conditional is the REAL guard; an optional HEAD
 * pre-check is an early-exit only (never the sole guard) and is left to callers.
 * NOTE: true R2 IfNoneMatch honoring can only be confirmed live (unit tests
 * emulate the precondition via a mock client).
 */
export async function putCreateOnly(client, bucket, key, body, contentType) {
    try {
        await client.send(new PutObjectCommand({
            Bucket: bucket, Key: key, Body: body,
            ContentType: contentType, IfNoneMatch: '*',
        }));
    } catch (err) {
        if (isPreconditionFailed(err)) {
            throw new Error(`[CREATE-ONLY] object already exists, refusing to overwrite: ${key} (collision -> RK-15)`);
        }
        throw err;
    }
}
