// @ts-nocheck
/**
 * RK-15 V3-B — production activation of the EXACT audited V3-A candidate. Runs
 * the REAL V3-A build first (to materialize a candidate + emit a descriptor),
 * then the REAL V3-B activation against the SAME store. (True R2 CAS honoring is
 * confirmed live by the workflow; these lock the CONTROL LOGIC + the
 * one-conditional-latest-PUT WRITE-GUARD + the descriptor contract.)
 *
 * Covers: descriptor mismatch (wrong snapshot_id/hash) -> FAIL; manifest hash
 * drift -> FAIL; required object missing -> FAIL; any non-latest PUT -> guard
 * FAIL; latest PUT without If-Match -> guard FAIL; CAS fail -> latest unchanged +
 * fail-loud; V3-B never rebuilds (no shard/manifest PUT). End-to-end: V3-A's
 * descriptor is consumed verbatim by V3-B (anti schema-drift).
 */

import { describe, it, expect } from 'vitest';
import { runV3A } from '../../scripts/verify/rk15-v3-candidate.js';
import { runV3B } from '../../scripts/verify/rk15-v3-activate.js';
import { instrumentActivateClient } from '../../scripts/verify/rk15-v3-lib.js';
import { validateDescriptorShape } from '../../scripts/verify/rk15-v3-eval.js';
import { makeR2Mock, seedSource, seedProdLatest, PROD_LATEST_KEY } from './helpers/rk15-v3-fixtures';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const HEAVY_MS = 60_000;

/** Build a real candidate into `mock`; return the V3-A evidence (incl. descriptor). */
async function buildCandidate(mock: any, runId = '5000') {
    seedSource(mock); seedProdLatest(mock);
    return runV3A({ client: mock, bucket: 'b', sourceRunId: '27413864028', date: '2026-06-13', runId, runAttempt: '1', commitSha: 'ccc', targetCid: 2244 });
}

describe('RK-15 V3-B — one-conditional-latest-PUT write-GUARD', () => {
    it('HARD-FAILS a non-latest PUT, a 2nd latest PUT, and a latest PUT WITHOUT If-Match', async () => {
        const inst = instrumentActivateClient({ async send() { return {}; } });
        await expect(inst.send(new PutObjectCommand({ Bucket: 'b', Key: 'snapshots/2026/x/shard.bin', Body: 'x', IfMatch: '"e"' }))).rejects.toThrow(/non-latest write/i);
        await expect(inst.send(new PutObjectCommand({ Bucket: 'b', Key: PROD_LATEST_KEY, Body: 'x' }))).rejects.toThrow(/WITHOUT If-Match/i);
        // one good conditional latest PUT, then a 2nd is refused.
        await inst.send(new PutObjectCommand({ Bucket: 'b', Key: PROD_LATEST_KEY, Body: 'x', IfMatch: '"e"' }));
        await expect(inst.send(new PutObjectCommand({ Bucket: 'b', Key: PROD_LATEST_KEY, Body: 'y', IfMatch: '"e"' }))).rejects.toThrow(/SECOND latest write/i);
        expect(inst.latestPutCount).toBe(1);
    });
});

describe('RK-15 V3-B — activates ONLY the exact audited candidate', () => {
    it('end-to-end: V3-A descriptor is consumed verbatim; ONE CAS -> ACTIVE; no rebuild', async () => {
        const mock = makeR2Mock();
        const a = await buildCandidate(mock);
        expect(a.a_pass).toBe(true);
        // V3-A descriptor + V3-B both satisfy the SHARED schema (anti drift).
        expect(validateDescriptorShape(a.descriptor).pass).toBe(true);
        const b = await runV3B({ client: mock, bucket: 'b', descriptor: a.descriptor, baseUrl: null, fetchImpl: null });
        expect(b.b_pass, JSON.stringify(b.checks)).toBe(true);
        expect(b.active_state).toBe('ACTIVE');
        expect(b.latest_put_count).toBe(1);
        // EXACTLY one PUT total, and it is production latest.
        expect(b.put_conditional_summary.putCount).toBe(1);
        expect(b.put_conditional_summary.writtenKeys).toEqual([PROD_LATEST_KEY]);
        // production latest now == the EXACT candidate payload (drift-free).
        expect(mock.store.get(PROD_LATEST_KEY).body).toBe(a.candidate_payload);
        const latest = JSON.parse(mock.store.get(PROD_LATEST_KEY).body);
        expect(latest.snapshot_id).toBe(a.snapshot_id);
        expect(latest.manifest_hash).toBe(a.manifest_hash);
    }, HEAVY_MS);

    it('descriptor snapshot_id mismatch -> FAIL', async () => {
        const mock = makeR2Mock();
        const a = await buildCandidate(mock);
        const bad = { ...a.descriptor, snapshot_id: '2026-06-13/0000-9' };
        await expect(runV3B({ client: mock, bucket: 'b', descriptor: bad, baseUrl: null, fetchImpl: null })).rejects.toThrow(/snapshot_id/i);
    }, HEAVY_MS);

    it('manifest_hash drift -> FAIL', async () => {
        const mock = makeR2Mock();
        const a = await buildCandidate(mock);
        const bad = { ...a.descriptor, manifest_hash: 'deadbeef'.repeat(8) };
        await expect(runV3B({ client: mock, bucket: 'b', descriptor: bad, baseUrl: null, fetchImpl: null })).rejects.toThrow(/manifest_hash|hash/i);
    }, HEAVY_MS);

    it('candidate payload hash drift -> FAIL', async () => {
        const mock = makeR2Mock();
        const a = await buildCandidate(mock);
        const bad = { ...a.descriptor, candidate_payload_hash: '0'.repeat(64) };
        await expect(runV3B({ client: mock, bucket: 'b', descriptor: bad, baseUrl: null, fetchImpl: null })).rejects.toThrow(/payload hash/i);
    }, HEAVY_MS);

    it('a required candidate object missing -> FAIL', async () => {
        const mock = makeR2Mock();
        const a = await buildCandidate(mock);
        // Drop a shard so validateCandidate's required-inventory check fails.
        for (const k of [...mock.store.keys()]) if (/shard-000\.bin$/.test(k) && k.startsWith(a.object_prefix)) mock.store.delete(k);
        await expect(runV3B({ client: mock, bucket: 'b', descriptor: a.descriptor, baseUrl: null, fetchImpl: null })).rejects.toThrow();
    }, HEAVY_MS);

    it('CAS fail (stale latest ETag) -> latest UNCHANGED + fail-loud, no rebuild', async () => {
        const mock = makeR2Mock();
        const a = await buildCandidate(mock);
        const before = mock.store.get(PROD_LATEST_KEY);
        // A store that REJECTS the If-Match CAS (simulates a concurrent writer winning).
        const realSend = mock.send.bind(mock);
        mock.send = async (cmd: any) => {
            if (cmd.constructor.name === 'PutObjectCommand' && cmd.input.Key === PROD_LATEST_KEY) {
                const e: any = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            return realSend(cmd);
        };
        const b = await runV3B({ client: mock, bucket: 'b', descriptor: a.descriptor, baseUrl: null, fetchImpl: null });
        expect(b.b_pass).toBe(false);
        expect(b.checks.cas_activation.pass).toBe(false);
        // old latest byte-unchanged; no candidate shard/manifest re-PUT happened.
        expect(mock.store.get(PROD_LATEST_KEY).body).toBe(before.body);
    }, HEAVY_MS);
});
