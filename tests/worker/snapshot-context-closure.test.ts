// @ts-nocheck
/**
 * RK-15 PR-A2 — reader-stage closure: EVERY served request reads
 * snapshots/latest.json EXACTLY ONCE and threads that single pinned
 * SnapshotContext to every sub-loader (repurposing once-only; standalone
 * once-only; same snapshot identity for all sub-loaders; publish-swap never
 * crosses snapshots; v1 + v2; contract error fails LOUD, never 404/empty).
 */

import { describe, it, expect } from 'vitest';
import { aggregateRepurposingEvidence } from '../../src/worker/lib/repurposing-aggregator';
import { loadTrialsForCompound } from '../../src/worker/lib/trial-loader';
import { loadBioactivitiesForCompound } from '../../src/worker/lib/bioactivity-loader';
import { loadPapersForCompound } from '../../src/worker/lib/paper-loader';
import { loadTargetIndex } from '../../src/worker/lib/target-loader';
import { handleBioactivities } from '../../src/worker/api/bioactivities';
import { handlePapers } from '../../src/worker/api/papers';
import { handleTrials } from '../../src/worker/api/trials';
import { handleTarget } from '../../src/worker/api/target';
import { SnapshotContractError, parseSnapshotContext } from '../../src/worker/lib/snapshot-context';
import { SourceLoadError } from '../../src/worker/lib/source-load-error';
import {
    LATEST, CID, gz, utf8, makeCountingBucket, makeEnv, fakeCtx, uniq,
    v1Store, v2Store, targetStore,
} from './_snapshot-fixtures';

describe('RK-15 PR-A2 — repurposing reads latest EXACTLY once', () => {
    it('v1: one composed request reads latest exactly once (neg+trials+bios+papers share it)', async () => {
        const tag = uniq();
        const { bucket, headCount } = makeCountingBucket(v1Store('2026-06-12', tag));
        const res = await aggregateRepurposingEvidence(bucket, CID, 'https://x.test');
        expect(res.snapshot_date).toBe('2026-06-12');
        expect(headCount[LATEST]).toBe(1); // EXACTLY once — the whole point of PR-A2
    });

    it('v2: one composed request reads latest exactly once', async () => {
        const tag = uniq();
        const { bucket, headCount } = makeCountingBucket(v2Store(`snapshots/immut-${tag}/`, `snap-${tag}`, tag));
        const res = await aggregateRepurposingEvidence(bucket, CID, 'https://x.test');
        expect(res.snapshot_date).toBe(`snap-${tag}`);
        expect(headCount[LATEST]).toBe(1);
    });

    it('all sub-loaders are pinned to ONE snapshot identity (every fetched key under one prefix)', async () => {
        // If any sub-loader re-derived its own snapshot it would read a DIFFERENT
        // prefix; here all four record layers resolve and every fetched object key
        // sits under the single pinned prefix.
        const date = '2026-06-12';
        const tag = uniq();
        const { bucket, getCount } = makeCountingBucket(v1Store(date, tag));
        const res = await aggregateRepurposingEvidence(bucket, CID, 'https://x.test');
        expect(res.summary.positive.trials.total).toBe(1);
        expect(res.summary.positive.bioactivities.total).toBe(1);
        expect(res.snapshot_date).toBe(date);
        const px = `snapshots/${date}/`;
        for (const key of Object.keys(getCount)) {
            if (key !== LATEST) expect(key.startsWith(px)).toBe(true);
        }
    });

    it('publish-swap mid-request never crosses snapshots (second read never happens)', async () => {
        // After the first COMPLETE latest read, the pointer "swaps". Because the
        // request reads latest only once, the swap is invisible — it stays pinned.
        const date = '2026-06-12';
        const tag = uniq();
        const store = v1Store(date, tag);
        const { bucket, headCount } = makeCountingBucket(store);
        const realGet = bucket.get.bind(bucket);
        let swapped = false;
        (bucket as any).get = async (key: string, opts?: any) => {
            const out = await realGet(key, opts);
            if (key === LATEST && !swapped) {
                swapped = true;
                store[LATEST] = { bytes: utf8(JSON.stringify({ latest_snapshot_date: '2099-01-01' })), etag: 'ptr-swapped' };
            }
            return out;
        };
        const res = await aggregateRepurposingEvidence(bucket, CID, 'https://x.test');
        expect(res.snapshot_date).toBe(date); // pinned to the ORIGINAL snapshot
        expect(headCount[LATEST]).toBe(1);    // second read NEVER happens
    });
});

describe('RK-15 PR-A2 — standalone endpoints each read latest exactly once', () => {
    const compoundEndpoints: Array<[string, any]> = [
        ['bioactivities', handleBioactivities],
        ['papers', handlePapers],
        ['trials', handleTrials],
    ];
    for (const [name, handler] of compoundEndpoints) {
        it(`GET /${name} reads latest once`, async () => {
            const tag = uniq();
            const { bucket, headCount } = makeCountingBucket(v1Store('2026-06-12', tag));
            const res = await handler(new Request(`https://x.test/api/v1/compound/${CID}/${name}`), makeEnv(bucket), fakeCtx());
            expect(res.status).toBe(200);
            expect(headCount[LATEST]).toBe(1);
        });
    }
    it('GET /target reads latest once (v1)', async () => {
        const tag = uniq();
        const { bucket, headCount } = makeCountingBucket(targetStore(`snapshots/2026-06-12/`, `ptr-${tag}`, tag));
        const res = await handleTarget(new Request('https://x.test/api/v1/target/P00533'), makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        expect(headCount[LATEST]).toBe(1);
    });
    it('GET /target reads latest once (v2 — uses declared object_prefix)', async () => {
        const tag = uniq();
        const px = `snapshots/immut-${tag}/`;
        const ptr = { layout_version: 'immutable_snapshot_v2', snapshot_id: `snap-${tag}`, object_prefix: px, compounds_manifest_key: `${px}cm.json` };
        const { bucket, headCount } = makeCountingBucket(targetStore(px, `ptr-${tag}`, tag, JSON.stringify(ptr)));
        const res = await handleTarget(new Request('https://x.test/api/v1/target/P00533'), makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        expect((await res.json() as any).snapshot_date).toBe(`snap-${tag}`);
        expect(headCount[LATEST]).toBe(1);
    });
});

describe('RK-15 PR-A2 — v2 satellite loaders are key-derived from the pinned ctx', () => {
    it('v2 loaders read the DECLARED object_prefix keys (not a date path)', async () => {
        const tag = uniq();
        const px = `snapshots/immut-${tag}/`;
        const ctx = parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2', snapshot_id: `snap-${tag}`,
            object_prefix: px, compounds_manifest_key: `${px}cm.json`,
        }));
        const { bucket } = makeCountingBucket(v2Store(px, `snap-${tag}`, tag));
        const [t, b, p] = await Promise.all([
            loadTrialsForCompound(bucket, ctx, CID),
            loadBioactivitiesForCompound(bucket, ctx, CID),
            loadPapersForCompound(bucket, ctx, CID),
        ]);
        expect(t).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(p).toHaveLength(1);
        const idx = JSON.stringify({ version: 'v', built_at: '', targets: {} });
        const { bucket: tb } = makeCountingBucket({ [`${px}target-index.json.gz`]: { bytes: gz(idx), etag: `i-${tag}` } });
        expect((await loadTargetIndex(tb, ctx)).snapshotDate).toBe(`snap-${tag}`);
    });
});

describe('RK-15 PR-A2 — contract error fails LOUD (no 404/empty degrade)', () => {
    it('aggregator: corrupt latest -> SnapshotContractError (never a "none" verdict)', async () => {
        const { bucket } = makeCountingBucket({ [LATEST]: { bytes: utf8('{ not json'), etag: uniq() } });
        const o = await aggregateRepurposingEvidence(bucket, CID, 'https://x.test').then(v => ({ ok: true, v }), e => ({ ok: false, e }));
        expect(o.ok).toBe(false);
        expect((o as any).e).toBeInstanceOf(SnapshotContractError);
    });
    it('aggregator: absent pointer -> typed SourceLoadError (LOUD), never falsely-empty', async () => {
        const { bucket } = makeCountingBucket({});
        const o = await aggregateRepurposingEvidence(bucket, CID, 'https://x.test').then(v => ({ ok: true, v }), e => ({ ok: false, e }));
        expect(o.ok).toBe(false);
        expect((o as any).e).toBeInstanceOf(SourceLoadError);
    });
    // Standalone endpoints: a contract violation is a LOUD 502 integrity error,
    // never a 404/empty degrade.
    const corrupt = () => makeCountingBucket({ [LATEST]: { bytes: utf8('{bad'), etag: uniq() } }).bucket;
    const unknownLayout = () => makeCountingBucket({ [LATEST]: { bytes: utf8(JSON.stringify({ layout_version: 'x', latest_snapshot_date: '2026-06-12' })), etag: uniq() } }).bucket;
    const cases: Array<[string, any, string, () => R2Bucket]> = [
        ['bioactivities (corrupt)', handleBioactivities, `/api/v1/compound/${CID}/bioactivities`, corrupt],
        ['trials (unknown layout_version)', handleTrials, `/api/v1/compound/${CID}/trials`, unknownLayout],
        ['target (corrupt, not the absence-404)', handleTarget, '/api/v1/target/P00533', corrupt],
    ];
    for (const [label, handler, path, mkBucket] of cases) {
        it(`standalone /${label} -> 502 integrity error`, async () => {
            const res = await handler(new Request(`https://x.test${path}`), makeEnv(mkBucket()), fakeCtx());
            expect(res.status).toBe(502);
        });
    }
});
