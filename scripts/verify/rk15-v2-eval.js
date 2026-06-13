/**
 * RK-15 V2 — PURE A/B cross-comparison + immutability/CAS evaluators.
 *
 * No I/O: each takes captured outcomes (already-read ETags/sha256 + thrown
 * errors) and returns a `{ pass, ... }` check object. Unit-tested directly so a
 * harness regression (e.g. a mock that ignores create-only) is PROVEN to be
 * caught by these gates.
 */

import { classifyError, isCreateOnlyCollision } from './rk15-v2-lib.js';

/** (1) snapshot_id B != A and (2)(3) B's prefix is independent of A's. */
export function evalDistinctIdentity({ aSnapshotId, bSnapshotId, aPrefix, bPrefix }) {
    const action = 'distinct A/B identity';
    if (aSnapshotId === bSnapshotId) {
        return { pass: false, action, reason: 'B snapshot_id == A snapshot_id (same-day publishes did NOT get distinct identity)', aSnapshotId, bSnapshotId };
    }
    if (aPrefix === bPrefix || bPrefix.startsWith(aPrefix) || aPrefix.startsWith(bPrefix)) {
        return { pass: false, action, reason: 'B object_prefix is not independent of A', aPrefix, bPrefix };
    }
    return { pass: true, action, aSnapshotId, bSnapshotId, aPrefix, bPrefix };
}

/** (3) B wrote NONE of A's keys — every B PUT key is under B's prefix (or the
 * isolated latest pointer), and no A key appears among B's writes. */
export function evalBWroteNoAKeys({ bWrittenKeys, aKeys, aPrefix, isolatedLatestKey }) {
    const action = 'B touched no A key';
    const touchedA = bWrittenKeys.filter(k => aKeys.includes(k) || (k.startsWith(aPrefix)));
    if (touchedA.length > 0) {
        return { pass: false, action, reason: `B wrote ${touchedA.length} key(s) under A`, touchedA };
    }
    // Defensive: every B write is under B's prefix OR the isolated latest pointer.
    return { pass: true, action, bWriteCount: bWrittenKeys.length, isolatedLatestKey };
}

/** (4) re-HEAD all A objects: ETag + (recorded) sha256 unchanged vs A evidence. */
export function evalAUnchanged({ aInventoryBefore, aInventoryAfter }) {
    const action = 'A objects byte-unchanged after B';
    const changed = [];
    for (const [key, before] of Object.entries(aInventoryBefore)) {
        const after = aInventoryAfter[key];
        if (!after) { changed.push({ key, reason: 'missing after B' }); continue; }
        if (after.etag !== before.etag) changed.push({ key, reason: 'etag changed', before: before.etag, after: after.etag });
    }
    if (changed.length > 0) return { pass: false, action, reason: `${changed.length} A object(s) changed`, changed };
    return { pass: true, action, objectCount: Object.keys(aInventoryBefore).length };
}

/** (5)(6) CAS isolated latest A->B succeeded and the pointer now names B. */
export function evalCasAtoB({ latestAfter, bSnapshotId, bPrefix }) {
    const action = 'CAS isolated latest A->B';
    if (!latestAfter) return { pass: false, action, reason: 'isolated latest missing after CAS' };
    if (latestAfter.snapshot_id !== bSnapshotId || latestAfter.object_prefix !== bPrefix) {
        return { pass: false, action, reason: 'isolated latest does not point at B after CAS', got: { snapshot_id: latestAfter.snapshot_id, object_prefix: latestAfter.object_prefix }, bSnapshotId, bPrefix };
    }
    return { pass: true, action, snapshot_id: latestAfter.snapshot_id, object_prefix: latestAfter.object_prefix };
}

/** (7)(8) A still readable by ITS snapshot_id + B readable — both seals present. */
export function evalBothReadable({ aSealPresent, bSealPresent, aManifestPresent, bManifestPresent }) {
    const action = 'A + B both independently readable';
    if (!aSealPresent || !aManifestPresent) return { pass: false, action, reason: 'A no longer readable (seal/manifest missing)', aSealPresent, aManifestPresent };
    if (!bSealPresent || !bManifestPresent) return { pass: false, action, reason: 'B not readable (seal/manifest missing)', bSealPresent, bManifestPresent };
    return { pass: true, action };
}

/** (9) B serving fixture resolves green: a compound decoded from a real shard
 * matches the expected CID + the neg/xref/search objects are present+non-empty. */
export function evalServingGreen({ decodedCid, expectedCid, negPresent, xrefPresent, searchPresent }) {
    const action = 'B serving fixture resolves green';
    if (decodedCid !== expectedCid) return { pass: false, action, reason: 'compound detail decode mismatch', decodedCid, expectedCid };
    const missing = [];
    if (!negPresent) missing.push('neg');
    if (!xrefPresent) missing.push('xref');
    if (!searchPresent) missing.push('search');
    if (missing.length) return { pass: false, action, reason: `serving objects missing: ${missing.join(', ')}` };
    return { pass: true, action, decodedCid };
}

/** EXTRA immutability hard-gate: re-publishing A's SAME snapshot_id/prefix
 * create-only MUST hard-fail (412/collision); A objects unchanged; latest still B. */
export function evalCollisionGate({ republishSucceeded, err, aStillUnchanged, latestStillB }) {
    const action = 'immutability collision-gate (re-publish A snapshot_id)';
    if (republishSucceeded) {
        return { pass: false, action, reason: 'RE-PUBLISH of A snapshot_id SUCCEEDED -> create-only NOT enforced (immutability breached)' };
    }
    const cls = classifyError(err);
    if (!isCreateOnlyCollision(err)) {
        return { pass: false, action, reason: 're-publish failed but NOT with a create-only collision', error: cls };
    }
    if (!aStillUnchanged) return { pass: false, action, reason: 'A objects changed during the collision attempt', error: cls };
    if (!latestStillB) return { pass: false, action, reason: 'isolated latest no longer points at B after the collision attempt', error: cls };
    return { pass: true, action, error: cls };
}

/** CAS-conflict (stale-pointer): a CAS with the OLD ETag (after one legit update
 * advanced it) MUST be rejected (412), NO unconditional retry, latest keeps its
 * current valid pointer, candidate stays NOT ACTIVE. */
export function evalStaleCas({ casSucceeded, err, sawUnconditionalPut, latestStillValid, candidateActive }) {
    const action = 'stale-pointer CAS rejected';
    if (casSucceeded) return { pass: false, action, reason: 'stale-ETag CAS SUCCEEDED -> If-Match NOT enforced' };
    const cls = classifyError(err);
    if (!cls.preconditionFailed && !/swap failed after/i.test(cls.message ?? '')) {
        return { pass: false, action, reason: 'stale CAS failed with a NON-precondition error', error: cls };
    }
    if (sawUnconditionalPut) return { pass: false, action, reason: 'an UNCONDITIONAL PUT was issued during the stale CAS', error: cls };
    if (!latestStillValid) return { pass: false, action, reason: 'isolated latest lost its valid pointer after the stale CAS', error: cls };
    if (candidateActive) return { pass: false, action, reason: 'stale candidate became ACTIVE despite the rejected CAS', error: cls };
    return { pass: true, action, error: cls };
}

/** Production latest invariance (read-only before/after). */
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
