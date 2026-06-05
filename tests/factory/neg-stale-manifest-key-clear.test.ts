// @ts-nocheck
/**
 * FIX M4 (factory side) — clear the stale neg manifest key on a skipped-neg run.
 *
 * stage-4-shard-orchestrator only SET neg_evidence_manifest_key when neg shards
 * published; on a SKIPPED-neg run it left the prior-day key untouched. The
 * terminal swap does {...current, ...updates}, so the stale key SURVIVED while
 * latest_snapshot_date advanced -> the worker computed a per-date neg manifest
 * path for a date with NO shards -> R2 404 -> /negative-evidence 503 ALL DAY.
 *
 * Two-layer fix asserted here:
 *   (1) the orchestrator now sets neg_evidence_manifest_key = null on skip;
 *   (2) swapLatestPointer DROPS a null/undefined update value from the merged
 *       latest.json (true removal, not a `"key": null` residue), so the worker's
 *       dual-path sees the key ABSENT -> legacy whole-file path.
 */

import { describe, it, expect } from 'vitest';
import { swapLatestPointer } from '../../scripts/factory/lib/publish-shards-and-swap.js';

const LATEST_KEY = 'snapshots/latest.json';

// Mock S3 client. swapLatestPointer issues GetObjectCommand (reads res.ETag +
// streams res.Body) and PutObjectCommand (writes Body, bumps etag). We branch on
// the real command's constructor name + read its .input (both verified present).
function makeMockClient(initial) {
    const store = new Map();
    let seq = 0;
    if (initial !== undefined) store.set(LATEST_KEY, { body: JSON.stringify(initial), etag: `"etag-${++seq}"` });
    const client = {
        async send(cmd) {
            const { Key } = cmd.input;
            if (cmd.constructor.name === 'GetObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
                async function* gen() { yield Buffer.from(o.body, 'utf-8'); }
                return { ETag: o.etag, Body: gen() };
            }
            store.set(Key, { body: cmd.input.Body, etag: `"etag-${++seq}"` });
            return {};
        },
    };
    return { client, current: () => JSON.parse(store.get(LATEST_KEY).body) };
}

describe('swapLatestPointer — stale neg key clearing (FIX M4)', () => {
    it('a null neg_evidence_manifest_key update REMOVES the stale key from latest.json', async () => {
        const prior = {
            latest_snapshot_date: '2026-06-04',
            compounds_manifest_key: 'snapshots/2026-06-04/compounds/bucket-0000/manifest.json',
            neg_evidence_manifest_key: 'snapshots/2026-06-04/neg-evidence/', // STALE prior-day key
        };
        const { client, current } = makeMockClient(prior);
        // Skipped-neg swapUpdates: advance date, refresh compounds, CLEAR neg key.
        const updates = {
            latest_snapshot_date: '2026-06-05',
            manifest_key: 'snapshots/2026-06-05/manifest.json',
            compounds_manifest_key: 'snapshots/2026-06-05/compounds/bucket-0000/manifest.json',
            neg_evidence_manifest_key: null,
        };
        const after = await swapLatestPointer(client, 'b', updates, ['latest_snapshot_date', 'compounds_manifest_key']);
        // The stale key is GONE (not present, not `null`).
        expect('neg_evidence_manifest_key' in after).toBe(false);
        expect(current().neg_evidence_manifest_key).toBeUndefined();
        // The advanced keys are present + current.
        expect(after.latest_snapshot_date).toBe('2026-06-05');
        expect(after.compounds_manifest_key).toBe('snapshots/2026-06-05/compounds/bucket-0000/manifest.json');
    });

    it('a real neg key (non-null) is still SET (no regression to the publish path)', async () => {
        const { client, current } = makeMockClient({ latest_snapshot_date: '2026-06-04' });
        const updates = {
            latest_snapshot_date: '2026-06-05',
            compounds_manifest_key: 'snapshots/2026-06-05/compounds/bucket-0000/manifest.json',
            neg_evidence_manifest_key: 'snapshots/2026-06-05/neg-evidence/',
        };
        const after = await swapLatestPointer(client, 'b', updates, ['latest_snapshot_date', 'neg_evidence_manifest_key']);
        expect(after.neg_evidence_manifest_key).toBe('snapshots/2026-06-05/neg-evidence/');
        expect(current().neg_evidence_manifest_key).toBe('snapshots/2026-06-05/neg-evidence/');
    });
});
