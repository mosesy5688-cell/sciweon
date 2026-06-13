// @ts-nocheck
/**
 * RK-15 V3-A — production candidate build (NO production-latest swap). Runs the
 * REAL V3-A flow against a mock R2 seeded with a complete 22-file Run #1 source.
 * (True R2 conditional honoring is confirmed live by the workflow; these lock
 * the CONTROL LOGIC + the candidate-prefix WRITE-GUARD.)
 *
 * Covers: over-boundary write to production latest -> guard FAIL; any missing
 * source file -> FAIL; empty source file -> FAIL; source ETag drift between
 * pre/post HEAD -> FAIL; candidate validation fail -> production latest
 * untouched; V3-A NEVER PUTs snapshots/latest.json.
 */

import { describe, it, expect } from 'vitest';
import { runV3A } from '../../scripts/verify/rk15-v3-candidate.js';
import { assertCandidateKey, instrumentCandidateClient, FIXED_SOURCE_PREFIX } from '../../scripts/verify/rk15-v3-lib.js';
import { makeR2Mock, seedSource, seedProdLatest, buildSourceBuffers, PROD_LATEST_KEY } from './helpers/rk15-v3-fixtures';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const HEAVY_MS = 60_000;
const RUN = { sourceRunId: '27413864028', date: '2026-06-13', runId: '5000', runAttempt: '1', commitSha: 'ccc', targetCid: 2244 };

async function v3a(mock: any, over: any = {}) {
    return runV3A({ client: mock, bucket: 'b', ...RUN, ...over });
}

describe('RK-15 V3-A — candidate-prefix write-GUARD', () => {
    const prefix = 'snapshots/2026-06-13/5000-1/';
    it('HARD-FAILS a write to production latest, any other snapshot prefix, or the source', () => {
        expect(() => assertCandidateKey('snapshots/latest.json', prefix)).toThrow(/PRODUCTION latest/i);
        expect(() => assertCandidateKey('snapshots/2026-06-13/9999-1/seal.json', prefix)).toThrow(/outside the candidate prefix/i);
        expect(() => assertCandidateKey('processed/aggregated/27413864028/x', prefix)).toThrow(/forbidden prefix/i);
        expect(() => assertCandidateKey('rk15-verification/v2/x', prefix)).toThrow(/forbidden prefix/i);
        expect(() => assertCandidateKey(`${prefix}compounds/bucket-0000/shard-000.bin`, prefix)).not.toThrow();
    });
    it('the instrumented client THROWS before a non-candidate PUT reaches R2', async () => {
        const inst = instrumentCandidateClient({ async send() { return {}; } }, prefix);
        await expect(inst.send(new PutObjectCommand({ Bucket: 'b', Key: PROD_LATEST_KEY, Body: 'x' }))).rejects.toThrow(/PRODUCTION latest/i);
    });
});

describe('RK-15 V3-A — happy path (candidate built, NOT active, prod latest untouched)', () => {
    it('builds + seals + validates the candidate; production latest GET-only', async () => {
        const mock = makeR2Mock();
        seedSource(mock);
        seedProdLatest(mock);
        const r = await v3a(mock);
        expect(r.a_pass, JSON.stringify(r.checks)).toBe(true);
        expect(r.candidate_state).toBe('VALIDATED');
        // V3-A NEVER wrote production latest.
        expect([...mock.store.keys()]).not.toContain(PROD_LATEST_KEY + '#written');
        expect(JSON.parse(mock.store.get(PROD_LATEST_KEY).body).latest_snapshot_date).toBe('2026-06-01');
        // every PUT landed under the candidate prefix.
        for (const e of r.put_conditional_summary.writtenKeys) expect(e.startsWith(r.object_prefix), e).toBe(true);
        // the descriptor is complete + bound to Run #1.
        expect(r.source_run_id).toBe('27413864028');
        expect(r.descriptor.candidate_payload_hash).toBe(r.candidate_payload_hash);
        // >=2 real NXVF shards.
        const shards = r.put_conditional_summary.writtenKeys.filter((k: string) => /shard-\d+\.bin$/.test(k));
        expect(shards.length).toBeGreaterThanOrEqual(2);
    }, HEAVY_MS);

    it('rejects a non-Run#1 source id (no pointer/latest dependency)', async () => {
        const mock = makeR2Mock();
        seedSource(mock); seedProdLatest(mock);
        await expect(v3a(mock, { sourceRunId: '99999999999' })).rejects.toThrow(/fixed Run #1/i);
    });
});

describe('RK-15 V3-A — source-integrity gates', () => {
    it('a MISSING source file -> FAIL (downloadStageByRunId would have returned empty, not thrown)', async () => {
        const mock = makeR2Mock();
        const bufs = buildSourceBuffers();
        delete bufs['papers.jsonl']; // omit one of the 22
        seedSource(mock, bufs); seedProdLatest(mock);
        await expect(v3a(mock)).rejects.toThrow(/required Run#1 file missing/i);
    }, HEAVY_MS);

    it('an EMPTY source file -> FAIL', async () => {
        const mock = makeR2Mock();
        const bufs = buildSourceBuffers();
        bufs['targets.jsonl'] = Buffer.alloc(0);
        seedSource(mock, bufs); seedProdLatest(mock);
        await expect(v3a(mock)).rejects.toThrow(/EMPTY/i);
    }, HEAVY_MS);

    it('source ETag DRIFT between pre-HEAD and post-HEAD -> FAIL', async () => {
        const mock = makeR2Mock();
        seedSource(mock); seedProdLatest(mock);
        // Flip one source object's etag the SECOND time it is HEAD-ed (post-HEAD).
        const driftKey = `${FIXED_SOURCE_PREFIX}diseases.jsonl`;
        let heads = 0;
        const realSend = mock.send.bind(mock);
        mock.send = async (cmd: any) => {
            if (cmd.constructor.name === 'HeadObjectCommand' && cmd.input.Key === driftKey) {
                heads += 1;
                if (heads === 2) { const o = mock.store.get(driftKey); mock.store.set(driftKey, { body: o.body, etag: '"drifted"' }); }
            }
            return realSend(cmd);
        };
        await expect(v3a(mock)).rejects.toThrow(/CHANGED during read/i);
    }, HEAVY_MS);

    it('candidate validation fail -> production latest untouched (a lax store breaks the seal hash)', async () => {
        // A store that DROPS the seal body would make validateCandidate throw; the
        // production latest is GET-only throughout, so it stays untouched.
        const mock = makeR2Mock();
        seedSource(mock); seedProdLatest(mock);
        const realSend = mock.send.bind(mock);
        mock.send = async (cmd: any) => {
            const r = await realSend(cmd);
            // Corrupt the seal AFTER it is written so validateCandidate's hash check fails.
            if (cmd.constructor.name === 'PutObjectCommand' && /_snapshot\.manifest\.json$/.test(cmd.input.Key)) {
                const o = mock.store.get(cmd.input.Key); mock.store.set(cmd.input.Key, { body: JSON.stringify({ ...JSON.parse(o.body), manifest_hash: 'tampered' }), etag: o.etag });
            }
            return r;
        };
        await expect(v3a(mock)).rejects.toThrow();
        expect(JSON.parse(mock.store.get(PROD_LATEST_KEY).body).latest_snapshot_date).toBe('2026-06-01');
    }, HEAVY_MS);
});
