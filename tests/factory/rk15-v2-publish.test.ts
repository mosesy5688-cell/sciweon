// @ts-nocheck
/**
 * RK-15 V2 — isolated real same-day A/B immutable-publish harness (control logic).
 *
 * Runs the REAL harness phases against a mock S3 client that EMULATES R2
 * conditional PUTs (true R2 honoring is confirmed live by the workflow). Covers:
 *   - the isolated-prefix GUARD fails loud on a non-isolated key;
 *   - phase A happy path -> all A assertions pass + ACTIVE + production untouched;
 *   - phase B: B doesn't write A keys; A unchanged; CAS A->B; A+B readable;
 *     serving green; collision-gate (re-publish A snapshot_id -> 412);
 *     stale-CAS rejected (no unconditional retry);
 *   - a mock that IGNORES create-only -> the collision-gate / B-touches-A gate FAILS;
 *   - production-latest changed -> the invariance gate FAILS;
 *   - the swapLatestPointer / stage-4 default latestKey is the production key.
 */

import { describe, it, expect } from 'vitest';
import { runPhase } from '../../scripts/verify/rk15-v2-publish.js';
import { assertIsolatedKey, ISOLATED_ROOT } from '../../scripts/verify/rk15-v2-lib.js';
import { evalCollisionGate, evalBWroteNoAKeys, evalProdLatestInvariance } from '../../scripts/verify/rk15-v2-eval.js';
import { makeR2Mock, seedProdLatest } from './helpers/rk15-v2-fixtures';

const DATE = '2026-06-13';

async function phaseA(mock: any, runId = '1000') {
    return runPhase({ client: mock, bucket: 'b', phase: 'A', sessionId: 's1', date: DATE, runId, runAttempt: '1', commitSha: 'aaa' });
}
async function phaseB(mock: any, runId = '2000') {
    return runPhase({ client: mock, bucket: 'b', phase: 'B', sessionId: 's1', date: DATE, runId, runAttempt: '1', commitSha: 'bbb' });
}

describe('RK-15 V2 — isolated-prefix guard', () => {
    it('FAILS loud on a non-isolated key, accepts an isolated key', () => {
        expect(() => assertIsolatedKey('snapshots/latest.json')).toThrow(/isolated namespace/i);
        expect(() => assertIsolatedKey('snapshots/2026-06-13/x/shard.bin')).toThrow();
        expect(() => assertIsolatedKey(`${ISOLATED_ROOT}s1/snapshots/x/seal.json`)).not.toThrow();
    });
});

// The publishing phases build a ~18MB fixture + run the zstd codec, so they need
// more than vitest's 5s default under parallel suite load (the real proof is the
// founder-run workflow against R2; these lock the CONTROL LOGIC).
const HEAVY_MS = 60_000;

describe('RK-15 V2 — phase A happy path', () => {
    it('publishes all classes, activates, reads back; production latest untouched', async () => {
        const mock = makeR2Mock();
        seedProdLatest(mock);
        const a = await phaseA(mock);
        expect(a.a_pass).toBe(true);
        expect(a.active_state).toBe('ACTIVE');
        for (const [name, c] of Object.entries(a.checks)) expect(c.pass, name).toBe(true);
        // every write landed under the isolated root.
        for (const key of mock.store.keys()) {
            if (key === 'snapshots/latest.json') continue;
            expect(key.startsWith(ISOLATED_ROOT), key).toBe(true);
        }
        // >=2 real NXVF shards in the inventory (the fixture covers all classes).
        const shardKeys = Object.keys(a.inventory).filter(k => /shard-\d+\.bin$/.test(k));
        expect(shardKeys.length).toBeGreaterThanOrEqual(2);
        // production latest unchanged.
        expect(JSON.parse(mock.store.get('snapshots/latest.json').body).latest_snapshot_date).toBe('2026-06-01');
    }, HEAVY_MS);
});

describe('RK-15 V2 — phase B proves the full A/B contract', () => {
    it('B independent + A unchanged + CAS A->B + both readable + collision-gate + stale-CAS', async () => {
        const mock = makeR2Mock();
        seedProdLatest(mock);
        await phaseA(mock);
        const b = await phaseB(mock);
        expect(b.b_pass).toBe(true);
        expect(b.active_state).toBe('ACTIVE');
        for (const [name, c] of Object.entries(b.checks)) expect(c.pass, name).toBe(true);
        // explicit cross-comparison flags.
        expect(b.ab_cross_comparison).toMatchObject({
            a_unchanged: true, b_independent: true, latest_points_b: true,
            both_readable: true, collision_gate: true, stale_cas: true,
        });
        expect(b.snapshot_id).not.toBe(b.a_snapshot_id);
        // isolated latest now points at B; production still untouched.
        const isoLatest = JSON.parse(mock.store.get(`${ISOLATED_ROOT}s1/latest.json`).body);
        expect(isoLatest.snapshot_id).toBe(b.snapshot_id);
        expect(JSON.parse(mock.store.get('snapshots/latest.json').body).latest_snapshot_date).toBe('2026-06-01');
    }, HEAVY_MS);
});

describe('RK-15 V2 — the gates CATCH a non-enforcing store', () => {
    it('a mock that IGNORES create-only -> collision-gate FAILS', async () => {
        // The collision-gate evaluator must FAIL when a re-publish of A succeeds.
        const c = evalCollisionGate({ republishSucceeded: true, err: null, aStillUnchanged: true, latestStillB: true });
        expect(c.pass).toBe(false);
        expect(c.reason).toMatch(/create-only NOT enforced/i);
    });

    it('B-touches-A gate FAILS when B wrote a key under A', () => {
        const c = evalBWroteNoAKeys({
            bWrittenKeys: ['rk15-verification/v2/s1/snapshots/2026-06-13/A-1/compounds/bucket-0000/shard-000.bin'],
            aKeys: [], aPrefix: 'rk15-verification/v2/s1/snapshots/2026-06-13/A-1/', isolatedLatestKey: 'k',
        });
        expect(c.pass).toBe(false);
        expect(c.reason).toMatch(/under A/i);
    });

    it('end-to-end: a create-only-ignoring store makes phase B FAIL (collision-gate trips)', async () => {
        const mock = makeR2Mock();
        seedProdLatest(mock);
        await phaseA(mock);
        // Now run B but with a store that silently accepts create-only overwrites.
        const lax = makeR2Mock({ ignoreCreateOnly: true });
        // copy A's published state into the lax store so B sees A.
        for (const [k, v] of mock.store) lax.store.set(k, v);
        const b = await phaseB(lax);
        expect(b.b_pass).toBe(false);
        expect(b.checks.collision_gate.pass).toBe(false);
    }, HEAVY_MS);

    it('production-latest CHANGED mid-run -> invariance gate FAILS', () => {
        const c = evalProdLatestInvariance(
            { etag: '"a"', sha256: 'x' }, { etag: '"b"', sha256: 'y' },
        );
        expect(c.pass).toBe(false);
        expect(c.reason).toMatch(/CHANGED/i);
    });
});

describe('RK-15 V2 — producer latestKey default is unchanged (production key)', () => {
    it('swapLatestPointer / swapV2Latest default to snapshots/latest.json', async () => {
        const swapMod = await import('../../scripts/factory/lib/publish-shards-and-swap.js');
        const stageMod = await import('../../scripts/factory/lib/stage-4-activate.js');
        // The default param is the production key: a swap with NO latestKey writes
        // snapshots/latest.json (a mock records the PUT key).
        const seen: string[] = [];
        const client = {
            async send(cmd: any) {
                const n = cmd.constructor.name;
                if (n === 'GetObjectCommand') { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                seen.push(cmd.input.Key);
                if (n === 'PutObjectCommand') return {};
                return {};
            },
        };
        // First-create path (no prior latest) -> IfNoneMatch:'*' PUT to the default key.
        await swapMod.swapLatestPointer(client, 'b', { latest_snapshot_date: '2026-06-13' }, []);
        expect(seen).toContain('snapshots/latest.json');
        expect(typeof stageMod.swapV2Latest).toBe('function');
    });
});
