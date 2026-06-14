// @ts-nocheck
/**
 * P-8 R1 read-only R2 probe tests -- mock S3 client + canned List/Head/Get.
 * Locks: the read-only guard (Put/Delete/Copy/Multipart refused + counted,
 * List/Head/Get pass), the two-part probe verdict (complete inventory + matching
 * identity -> pass; every drift class -> fail), the AGGREGATED_FILES length
 * guard, the order-independent inventory hash, and latest GET called exactly once.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
    PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
    CopyObjectCommand, CreateMultipartUploadCommand,
    ListObjectsV2Command, HeadObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { AGGREGATED_FILES } from '../../scripts/factory/lib/aggregated-files.js';
import {
    instrumentReadOnlyClient, runAggregateInventory, runLatestIdentity,
    computeProbePass, aggregatePrefix, aggregateInventoryHash,
    assertAggregatedFilesLength, sha256Hex,
} from '../../scripts/verify/p8-r1-readonly-probe-lib.js';

const BUCKET = 'sciweon-r2';
const RUN_ID = '27494573900';
const PREFIX = aggregatePrefix(RUN_ID);
const SNAPSHOT_ID = '2026-06-14/27489690948-1';

function sha(s: string) { return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex'); }

function latestBody(over: any = {}) {
    return JSON.stringify({
        layout_version: 'immutable_snapshot_v2',
        snapshot_id: SNAPSHOT_ID,
        object_prefix: `snapshots/${SNAPSHOT_ID}/`,
        compounds_manifest_key: `snapshots/${SNAPSHOT_ID}/compounds.manifest.json`,
        manifest_hash: 'mh-default',
        ...over,
    });
}

function policyBody(over: any = {}) {
    return JSON.stringify({
        publication_policy: 'MANUAL_ONLY', mode: 'backfill_only',
        aggregated_run_id: RUN_ID, ...over,
    });
}

/** Build a mock store seeded with N aggregate files + policy + latest. */
function makeStore(opts: any = {}) {
    const store = new Map<string, Buffer>();
    const files = opts.files || AGGREGATED_FILES;
    for (const f of files) store.set(`${PREFIX}${f}`, Buffer.from(`content-of-${f}`, 'utf-8'));
    if (opts.policy !== null) store.set(`${PREFIX}_publish_policy.json`, Buffer.from(opts.policy ?? policyBody(), 'utf-8'));
    if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) store.set(k, Buffer.from(v as string, 'utf-8'));
    store.set('snapshots/latest.json', Buffer.from(opts.latest ?? latestBody(), 'utf-8'));
    return store;
}

function makeMock(store: Map<string, Buffer>) {
    let seq = 0;
    return {
        store,
        getCount: 0,
        async send(cmd: any) {
            const name = cmd.constructor.name;
            if (name === 'ListObjectsV2Command') {
                const prefix = cmd.input.Prefix;
                const keys = [...store.keys()].filter(k => k.startsWith(prefix));
                return { IsTruncated: false, Contents: keys.map(k => ({ Key: k, Size: store.get(k)!.length, ETag: `"et-${k}"`, LastModified: new Date('2026-06-14T00:00:00Z') })) };
            }
            if (name === 'HeadObjectCommand') {
                const o = store.get(cmd.input.Key);
                if (!o) { const e: any = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                return { ETag: `"et-${cmd.input.Key}"`, ContentLength: o.length, LastModified: new Date('2026-06-14T00:00:00Z') };
            }
            if (name === 'GetObjectCommand') {
                this.getCount += 1;
                const o = store.get(cmd.input.Key);
                if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                async function* gen() { yield o; }
                return { ETag: `"et-${cmd.input.Key}"`, Body: gen() };
            }
            const e: any = new Error(`mock store reached by a write command ${name} -- guard FAILED`);
            e.name = 'WriteReachedStore';
            throw e;
        },
    };
}

async function runProbe(store: Map<string, Buffer>, expected: any = {}) {
    const mock = makeMock(store);
    const client = instrumentReadOnlyClient(mock);
    const exp = { snapshot_id: SNAPSHOT_ID, payload_sha256: sha(store.get('snapshots/latest.json')!.toString('utf-8')), manifest_hash: 'mh-default', ...expected };
    const part1 = await runAggregateInventory(client, BUCKET, RUN_ID);
    const part2 = await runLatestIdentity(client, BUCKET, exp);
    const verdict = computeProbePass(part1, part2, client);
    return { mock, client, part1, part2, verdict };
}

describe('P8R1 read-only guard', () => {
    it('(1) refuses PutObject + increments write_attempt_count, never reaching the store', async () => {
        const mock = makeMock(makeStore());
        const client = instrumentReadOnlyClient(mock);
        await expect(client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'x', Body: 'y' }))).rejects.toThrow(/READ-ONLY GUARD/);
        expect(client.put_count).toBe(1);
        expect(client.write_attempt_count).toBe(1);
        expect(client.delete_count).toBe(0);
    });

    it('(2) refuses Delete / DeleteObjects / Copy / Multipart commands', async () => {
        const client = instrumentReadOnlyClient(makeMock(makeStore()));
        await expect(client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'x' }))).rejects.toThrow(/READ-ONLY GUARD/);
        await expect(client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [] } }))).rejects.toThrow(/READ-ONLY GUARD/);
        await expect(client.send(new CopyObjectCommand({ Bucket: BUCKET, Key: 'x', CopySource: 'a/b' }))).rejects.toThrow(/READ-ONLY GUARD/);
        await expect(client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'x' }))).rejects.toThrow(/READ-ONLY GUARD/);
        expect(client.delete_count).toBe(2);
        expect(client.write_attempt_count).toBe(4);
        expect(client.put_count).toBe(0);
    });

    it('(3) passes List / Head / Get through to the real client', async () => {
        const store = makeStore();
        const client = instrumentReadOnlyClient(makeMock(store));
        await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX }));
        await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}trials.jsonl` }));
        await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}trials.jsonl` }));
        expect(client.readCounts).toEqual({ list: 1, head: 1, get: 1 });
        expect(client.write_attempt_count).toBe(0);
    });
});

describe('P8R1 probe verdict', () => {
    it('(4) complete inventory (22 + sidecar, matching identity) -> probe_pass=true', async () => {
        const { part1, part2, verdict } = await runProbe(makeStore());
        expect(part1.aggregate_files).toBe(22);
        expect(part1.control_sidecars).toBe(1);
        expect(part1.part1_pass).toBe(true);
        expect(part2.part2_pass).toBe(true);
        expect(verdict.probe_pass).toBe(true);
        expect(verdict.put_count).toBe(0);
        expect(verdict.delete_count).toBe(0);
        expect(verdict.write_attempt_count).toBe(0);
    });

    it('(5) a missing aggregate file -> false', async () => {
        const files = AGGREGATED_FILES.filter(f => f !== 'trials.jsonl');
        const { part1, verdict } = await runProbe(makeStore({ files }));
        expect(part1.missing_files).toContain('trials.jsonl');
        expect(part1.assertions.all_aggregate_files_present).toBe(false);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(6) an unexpected extra object -> false', async () => {
        const store = makeStore({ extra: { [`${PREFIX}rogue.txt`]: 'surprise' } });
        const { part1, verdict } = await runProbe(store);
        expect(part1.unexpected_objects).toContain(`${PREFIX}rogue.txt`);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(7) publication_policy != MANUAL_ONLY -> false', async () => {
        const { part1, verdict } = await runProbe(makeStore({ policy: policyBody({ publication_policy: 'AUTO' }) }));
        expect(part1.assertions.policy_publication_policy_ok).toBe(false);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(8) mode != backfill_only -> false', async () => {
        const { part1, verdict } = await runProbe(makeStore({ policy: policyBody({ mode: 'full' }) }));
        expect(part1.assertions.policy_mode_ok).toBe(false);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(9) policy aggregated_run_id mismatch -> false', async () => {
        const { part1, verdict } = await runProbe(makeStore({ policy: policyBody({ aggregated_run_id: '999' }) }));
        expect(part1.assertions.policy_run_id_ok).toBe(false);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(10) snapshot_id drift -> false', async () => {
        const { part2, verdict } = await runProbe(makeStore(), { snapshot_id: 'other/123-1' });
        expect(part2.assertions.snapshot_id_match).toBe(false);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(11) payload_sha256 drift -> false', async () => {
        const { part2, verdict } = await runProbe(makeStore(), { payload_sha256: 'deadbeef' });
        expect(part2.assertions.payload_sha256_match).toBe(false);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(12) manifest_hash drift -> false', async () => {
        const { part2, verdict } = await runProbe(makeStore(), { manifest_hash: 'wrong' });
        expect(part2.assertions.manifest_hash_match).toBe(false);
        expect(verdict.probe_pass).toBe(false);
    });

    it('(13) legacy_v1 / unparseable latest -> hard fail', async () => {
        const legacy = await runProbe(makeStore({ latest: JSON.stringify({ latest_snapshot_date: '2026-06-14' }) }));
        expect(legacy.part2.production_layout_version).toBe('legacy_v1');
        expect(legacy.part2.part2_pass).toBe(false);
        expect(legacy.verdict.probe_pass).toBe(false);
        const broken = await runProbe(makeStore({ latest: 'not-json{' }));
        expect(broken.part2.parse_error).toBeTruthy();
        expect(broken.part2.part2_pass).toBe(false);
    });
});

describe('P8R1 SSoT + hash + read-once invariants', () => {
    it('(14) AGGREGATED_FILES length guard: !=22 fails loud', () => {
        expect(AGGREGATED_FILES.length).toBe(22);
        expect(() => assertAggregatedFilesLength(AGGREGATED_FILES)).not.toThrow();
        const drifted = [...AGGREGATED_FILES, 'extra.jsonl'];
        expect(() => assertAggregatedFilesLength(drifted)).toThrow(/length drift/);
    });

    it('(15) aggregate_inventory_hash deterministic + order-independent', () => {
        const inv = AGGREGATED_FILES.map((f, i) => ({ key: `${PREFIX}${f}`, size: 10 + i, etag: `"et-${f}"` }));
        const h1 = aggregateInventoryHash(inv);
        const shuffled = [...inv].reverse();
        const h2 = aggregateInventoryHash(shuffled);
        expect(h2).toBe(h1);
        const changed = inv.map((o, i) => i === 0 ? { ...o, size: o.size + 1 } : o);
        expect(aggregateInventoryHash(changed)).not.toBe(h1);
    });

    it('(16) latest GET called exactly once', async () => {
        // Isolated run so getCount reflects only the single latest GET.
        const store = makeStore();
        const m = makeMock(store);
        const client = instrumentReadOnlyClient(m);
        const before = m.getCount;
        await runLatestIdentity(client, BUCKET, { snapshot_id: SNAPSHOT_ID, payload_sha256: sha(store.get('snapshots/latest.json')!.toString('utf-8')), manifest_hash: 'mh-default' });
        expect(m.getCount - before).toBe(1);
    });
});
