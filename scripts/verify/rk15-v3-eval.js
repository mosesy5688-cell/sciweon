/**
 * RK-15 V3 — PURE evaluators + the V3-A -> V3-B candidate-descriptor contract.
 *
 * No I/O: each evaluator takes captured outcomes (send-logs / read ETags+sha256 /
 * thrown errors) and returns a `{ pass, ... }` check object. Unit-tested directly
 * so a harness regression (e.g. a guard that fails open) is PROVEN to be caught.
 *
 * The DESCRIPTOR is defined ONCE here and asserted at BOTH ends (V3-A emits,
 * V3-B consumes) so the two scripts can never drift apart.
 */

import { PROD_LATEST_KEY, summarizePutConditionals } from './rk15-v3-lib.js';
import { classifyError } from './rk15-v3-lib.js';

/** No unconditional PUT was issued (every write carried IfNoneMatch or IfMatch). */
export function evalNoUnconditionalPut(sendLog) {
    const s = summarizePutConditionals(sendLog);
    if (s.unconditionalPutCount > 0) {
        return { pass: false, action: 'no-unconditional-put audit', reason: `${s.unconditionalPutCount} unconditional PUT(s)`, unconditionalKeys: s.unconditionalKeys };
    }
    return { pass: true, action: 'no-unconditional-put audit', putCount: s.putCount, conditionalPutCount: s.conditionalPutCount };
}

/** Production latest.json read-only invariance (V3-A: before == after, GET-only). */
export function evalProdLatestInvariance(prodBefore, prodAfter) {
    const action = 'production latest.json read-only (before == after)';
    const beforePresent = prodBefore != null, afterPresent = prodAfter != null;
    const identical = beforePresent === afterPresent
        && (prodBefore?.etag ?? null) === (prodAfter?.etag ?? null)
        && (prodBefore?.sha256 ?? null) === (prodAfter?.sha256 ?? null);
    if (identical) return { pass: true, action, present: afterPresent, etag: prodAfter?.etag ?? null, sha256: prodAfter?.sha256 ?? null };
    return {
        pass: false, action, reason: 'production latest.json CHANGED between before/after',
        before: { present: beforePresent, etag: prodBefore?.etag ?? null, sha256: prodBefore?.sha256 ?? null },
        after: { present: afterPresent, etag: prodAfter?.etag ?? null, sha256: prodAfter?.sha256 ?? null },
    };
}

/** Every V3-A PUT is under the candidate prefix (post-hoc send-log audit). */
export function evalAllWritesUnderCandidate(sendLog, candidatePrefix) {
    const puts = sendLog.filter(e => e.command === 'PutObjectCommand');
    const escaped = puts.map(e => e.key).filter(k => !k || !k.startsWith(candidatePrefix));
    if (escaped.length > 0) {
        return { pass: false, action: 'candidate-prefix audit', reason: `${escaped.length} PUT(s) escaped the candidate prefix`, escapedKeys: escaped };
    }
    return { pass: true, action: 'candidate-prefix audit', putCount: puts.length, candidatePrefix };
}

/** V3-A NEVER wrote production latest (the gate's defining negative). */
export function evalNoProdLatestWrite(sendLog) {
    const wrote = sendLog.filter(e => e.command === 'PutObjectCommand' && e.key === PROD_LATEST_KEY);
    if (wrote.length > 0) {
        return { pass: false, action: 'no production-latest write', reason: `V3-A wrote ${PROD_LATEST_KEY} ${wrote.length} time(s)` };
    }
    return { pass: true, action: 'no production-latest write' };
}

// ── V3-B activation evaluators ───────────────────────────────────────────────

/** The descriptor presented to V3-B matches the audited candidate's actual seal. */
export function evalDescriptorMatch({ descriptor, candidatePayloadHash, sealSnapshotId, sealManifestHash }) {
    const action = 'descriptor == audited candidate (snapshot_id + manifest_hash + payload_hash)';
    if (descriptor.candidate_payload_hash !== candidatePayloadHash) {
        return { pass: false, action, reason: 'candidate_payload_hash mismatch (candidate latest payload drifted)', expected: descriptor.candidate_payload_hash, got: candidatePayloadHash };
    }
    if (descriptor.snapshot_id !== sealSnapshotId) {
        return { pass: false, action, reason: 'snapshot_id mismatch vs the candidate seal', expected: descriptor.snapshot_id, got: sealSnapshotId };
    }
    if (descriptor.manifest_hash !== sealManifestHash) {
        return { pass: false, action, reason: 'manifest_hash mismatch vs the candidate seal', expected: descriptor.manifest_hash, got: sealManifestHash };
    }
    return { pass: true, action, snapshot_id: sealSnapshotId, manifest_hash: sealManifestHash };
}

/** The CAS production-latest swap succeeded to the EXACT candidate payload, and a
 * re-read confirms latest now names this candidate (ACTIVE derived from the
 * pointer fact, never written into a candidate object). */
export function evalCasActivation({ casSucceeded, casError, latestAfter, snapshotId, manifestHash }) {
    const action = 'CAS production latest -> this candidate (ACTIVE)';
    if (!casSucceeded) return { pass: false, action, reason: 'CAS production-latest swap did NOT succeed', error: classifyError(casError) };
    if (!latestAfter) return { pass: false, action, reason: 'production latest missing after CAS' };
    if (latestAfter.layout_version !== 'immutable_snapshot_v2'
        || latestAfter.snapshot_id !== snapshotId
        || latestAfter.manifest_hash !== manifestHash) {
        return { pass: false, action, reason: 'production latest does not point at this candidate after CAS', got: { snapshot_id: latestAfter.snapshot_id, manifest_hash: latestAfter.manifest_hash }, snapshotId, manifestHash };
    }
    return { pass: true, action, snapshot_id: latestAfter.snapshot_id, manifest_hash: latestAfter.manifest_hash };
}

/** A CAS conflict (stale If-Match) must fail LOUD: old latest unchanged, NO
 * unconditional retry, NO candidate rebuild. */
export function evalCasConflictRollback({ casError, sawUnconditionalPut, oldLatestUnchanged }) {
    const action = 'CAS conflict -> fail-loud, old latest unchanged, no unconditional retry';
    const cls = classifyError(casError);
    if (!cls.preconditionFailed && !/swap failed after/i.test(cls.message ?? '')) {
        return { pass: false, action, reason: 'CAS conflict surfaced a NON-precondition error', error: cls };
    }
    if (sawUnconditionalPut) return { pass: false, action, reason: 'an UNCONDITIONAL latest PUT was issued after the CAS conflict', error: cls };
    if (!oldLatestUnchanged) return { pass: false, action, reason: 'old production latest CHANGED despite the CAS conflict', error: cls };
    return { pass: true, action, error: cls };
}

// ── V3-A -> V3-B DESCRIPTOR CONTRACT (anti schema-drift) ──────────────────────

/**
 * The SHARED candidate descriptor — the EXACT set of fields V3-A emits and V3-B
 * consumes to re-validate + activate ONLY the audited candidate.
 */
export const DESCRIPTOR_FIELDS = Object.freeze([
    'snapshot_id',
    'object_prefix',
    'manifest_key',
    'manifest_hash',
    'candidate_payload_hash',
    'v3a_run_id',
]);

/** Build the descriptor object from a candidate evidence pack (V3-A side). */
export function buildDescriptor({ snapshotId, objectPrefix, manifestKey, manifestHash, candidatePayloadHash, v3aRunId }) {
    return {
        snapshot_id: snapshotId,
        object_prefix: objectPrefix,
        manifest_key: manifestKey,
        manifest_hash: manifestHash,
        candidate_payload_hash: candidatePayloadHash,
        v3a_run_id: v3aRunId,
    };
}

/** Validate a descriptor carries EXACTLY the contract fields, all non-empty strings. */
export function validateDescriptorShape(desc) {
    const action = 'descriptor schema (V3-A emits == V3-B consumes)';
    if (!desc || typeof desc !== 'object') return { pass: false, action, reason: 'descriptor is not an object' };
    const keys = Object.keys(desc).sort();
    const expected = [...DESCRIPTOR_FIELDS].sort();
    const missing = expected.filter(f => !(f in desc));
    const extra = keys.filter(k => !expected.includes(k));
    if (missing.length || extra.length) {
        return { pass: false, action, reason: 'descriptor field-set drift', missing, extra };
    }
    const empty = expected.filter(f => typeof desc[f] !== 'string' || desc[f].length === 0);
    if (empty.length) return { pass: false, action, reason: 'descriptor has empty/non-string fields', empty };
    return { pass: true, action, fields: expected };
}
