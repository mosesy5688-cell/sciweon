/**
 * RK-15 PR-A — reader migration integration tests (mocked R2 + Cache API).
 *
 * Locks the cross-cutting guarantees the dual-contract reader + per-request
 * SnapshotContext must hold against real loaders:
 *   - a /compound request reads latest.json EXACTLY ONCE
 *   - legacy_v1 reads the date-derived sharded layout (preserved behavior)
 *   - immutable_v2 reads the DECLARED keys (no path self-reconstruction)
 *   - every cache layer's key embeds the snapshot identity (manifest / xref /
 *     neg / range)
 *   - the range cache can NEVER return a different snapshot's shard bytes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadTier1 } from './compound-loader';
import { loadManifest } from './compound-manifest-loader';
import { loadXrefKind } from './xref-index-loader';
import { loadNegBucketManifest } from './neg-manifest-loader';
import { fetchR2RangeBytes } from './r2-fetch';
import { parseSnapshotContext } from './snapshot-context';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

interface MockObject { bytes: Uint8Array; etag: string; }

/** Mock R2 that records head/get/range calls AND per-key get counts. */
function makeMockBucket(store: Record<string, MockObject>) {
    const getCounts: Record<string, number> = {};
    const bucket = {
        getCounts,
        async head(key: string) {
            const o = store[key];
            return o ? { size: o.bytes.length, etag: o.etag } : null;
        },
        async get(key: string, opts?: { range?: { offset: number; length: number } }) {
            const o = store[key];
            if (!o) return null;
            getCounts[key] = (getCounts[key] ?? 0) + 1;
            const slice = opts?.range
                ? o.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length)
                : o.bytes;
            return {
                etag: o.etag,
                async arrayBuffer() {
                    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
                },
            };
        },
    };
    return bucket as unknown as R2Bucket & { getCounts: Record<string, number> };
}

/** Capturing Cache API: records every key (Request URL) put/matched. */
function installCapturingCache() {
    const puts: string[] = [];
    const matches: string[] = [];
    const storeText = new Map<string, string>();
    (globalThis as any).caches = {
        default: {
            async match(req: Request) {
                matches.push(req.url);
                const t = storeText.get(req.url);
                return t === undefined ? undefined : new Response(t);
            },
            async put(req: Request, resp: Response) {
                puts.push(req.url);
                storeText.set(req.url, await resp.text());
            },
        },
    };
    return { puts, matches };
}

function json(obj: unknown): MockObject {
    return { bytes: new TextEncoder().encode(JSON.stringify(obj)), etag: `etag-${Math.random()}` };
}

const ASPIRIN = { id: 'sciweon::compound::CID:2244', pubchem_cid: 2244, chembl_id: 'CHEMBL25' };
const ASPIRIN_BYTES = new TextEncoder().encode(JSON.stringify(ASPIRIN)); // Phase-1 plaintext shard

function makeEnv(bucket: R2Bucket) {
    return { SCIWEON_R2: bucket } as any;
}

beforeEach(() => {
    // fresh isolate caches between tests: re-import is heavy, so we rely on
    // distinct snapshot identities per test to avoid per-isolate Map reuse.
});

describe('legacy_v1 — read-once + date-derived sharded read (behavior preserved)', () => {
    it('reads latest.json exactly once and serves the compound via the date layout', async () => {
        const date = '2026-05-19';
        const manifest = {
            version: '1', bucket: 0, snapshot_date: date, generated_at: 'now',
            total_records: 1, shard_count: 1,
            entries: [{
                cid: 2244, inchi_key: null, chembl_id: 'CHEMBL25', unii: null, drugbank_id: null,
                bucket: 0, shard: 0, offset: 0, size: ASPIRIN_BYTES.length,
            }],
            shard_hashes: [],
        };
        const bucket = makeMockBucket({
            'snapshots/latest.json': json({
                latest_snapshot_date: date,
                compounds_manifest_key: `snapshots/${date}/compounds/bucket-0000/manifest.json`,
            }),
            [`snapshots/${date}/compounds/bucket-0000/manifest.json`]: json(manifest),
            [`snapshots/${date}/compounds/bucket-0000/shard-000.bin`]: { bytes: ASPIRIN_BYTES, etag: 's1' },
        });
        installCapturingCache();

        const rec = await loadTier1(makeEnv(bucket), 2244);
        expect(rec?.pubchem_cid).toBe(2244);
        // latest.json read EXACTLY ONCE for the whole request.
        expect(bucket.getCounts['snapshots/latest.json']).toBe(1);
    });
});

describe('immutable_snapshot_v2 — reads DECLARED keys (no path self-reconstruction)', () => {
    it('serves the compound from the v2 declared compounds_manifest_key prefix', async () => {
        const sid = 'snap-2026-06-13-xyz';
        const prefix = `snapshots/${sid}/`;
        const manifestKey = `${prefix}compounds/bucket-0000/manifest.json`;
        const shardKey = `${prefix}compounds/bucket-0000/shard-000.bin`;
        const manifest = {
            version: '1', bucket: 0, snapshot_date: sid, generated_at: 'now',
            total_records: 1, shard_count: 1,
            entries: [{
                cid: 2244, inchi_key: null, chembl_id: 'CHEMBL25', unii: null, drugbank_id: null,
                bucket: 0, shard: 0, offset: 0, size: ASPIRIN_BYTES.length,
            }],
            shard_hashes: [],
        };
        const bucket = makeMockBucket({
            'snapshots/latest.json': json({
                layout_version: 'immutable_snapshot_v2',
                snapshot_id: sid,
                object_prefix: prefix,
                compounds_manifest_key: manifestKey,
                manifest_hash: 'sha256:zzz',
            }),
            [manifestKey]: json(manifest),
            [shardKey]: { bytes: ASPIRIN_BYTES, etag: 's2' },
        });
        installCapturingCache();

        const rec = await loadTier1(makeEnv(bucket), 2244);
        expect(rec?.pubchem_cid).toBe(2244);
        expect(bucket.getCounts['snapshots/latest.json']).toBe(1);
        // proves it read the DECLARED shard key, not a reconstructed-from-date one.
        expect(bucket.getCounts[shardKey]).toBe(1);
    });
});

describe('cache keys embed the snapshot identity — every layer', () => {
    it('(a) compound manifest Cache API key includes the identity token', async () => {
        const { puts } = installCapturingCache();
        const ctx = parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2', snapshot_id: 'S-AAA',
            object_prefix: 'snapshots/S-AAA/',
            compounds_manifest_key: 'snapshots/S-AAA/compounds/bucket-0000/manifest.json',
            manifest_hash: 'sha256:H1',
        }));
        const bucket = makeMockBucket({
            'snapshots/S-AAA/compounds/bucket-0000/manifest.json': json({
                version: '1', bucket: 0, snapshot_date: 'S-AAA', generated_at: 'now',
                total_records: 0, shard_count: 0, entries: [], shard_hashes: [],
            }),
        });
        await loadManifest(bucket, 0, ctx);
        expect(puts.some(u => u.includes(encodeURIComponent('immutable_snapshot_v2:S-AAA:sha256:H1')))).toBe(true);
    });

    it('(b) xref Cache API key includes the identity token', async () => {
        const { puts } = installCapturingCache();
        const ctx = parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2', snapshot_id: 'S-BBB',
            object_prefix: 'snapshots/S-BBB/',
            compounds_manifest_key: 'snapshots/S-BBB/compounds/bucket-0000/manifest.json',
            xref_index_key: 'snapshots/S-BBB/xref-index.json.gz',
            manifest_hash: 'sha256:H2',
        }));
        const bucket = makeMockBucket({
            'snapshots/S-BBB/xref-index.json.gz': {
                bytes: gzipSync(JSON.stringify({ version: '1', index: { chembl_id: { CHEMBL25: 2244 } } })),
                etag: 'x',
            },
        });
        const map = await loadXrefKind(bucket, ctx, 'chembl_id');
        expect(map.get('CHEMBL25')).toBe(2244);
        expect(puts.some(u => u.includes(encodeURIComponent('immutable_snapshot_v2:S-BBB:sha256:H2')))).toBe(true);
    });

    it('(c+e) neg manifest Cache API key includes the identity token', async () => {
        const { puts } = installCapturingCache();
        const ctx = parseSnapshotContext(JSON.stringify({
            layout_version: 'immutable_snapshot_v2', snapshot_id: 'S-CCC',
            object_prefix: 'snapshots/S-CCC/',
            compounds_manifest_key: 'snapshots/S-CCC/compounds/bucket-0000/manifest.json',
            neg_evidence_manifest_key: 'snapshots/S-CCC/neg-evidence/bucket-0000/manifest.json',
            manifest_hash: 'sha256:H3',
        }));
        const bucket = makeMockBucket({
            'snapshots/S-CCC/neg-evidence/bucket-0000/manifest.json': json({
                version: '1', bucket: 0, snapshot_date: 'S-CCC', generated_at: 'now',
                total_records: 0, shard_count: 0, entries: [], shard_hashes: [],
            }),
        });
        await loadNegBucketManifest(bucket, 0, ctx);
        expect(puts.some(u => u.includes(encodeURIComponent('immutable_snapshot_v2:S-CCC:sha256:H3')))).toBe(true);
    });
});

describe('(c/d) range cache NEVER returns across snapshots', () => {
    it('same object key + offset + length but different identity -> distinct bytes', async () => {
        // Two snapshots happen to share an object key (pathological) at the same
        // (offset,length). Identity binding must keep them apart.
        const KEY = 'snapshots/shared/compounds/bucket-0000/shard-000.bin';
        const bytesA = new TextEncoder().encode('AAAAAAAA');
        const bytesB = new TextEncoder().encode('BBBBBBBB');

        // First snapshot identity caches bytesA.
        const bucketA = makeMockBucket({ [KEY]: { bytes: bytesA, etag: 'eA' } });
        const a = await fetchR2RangeBytes(bucketA, KEY, 0, 8, 'identity-A');
        expect(new TextDecoder().decode(a)).toBe('AAAAAAAA');

        // Second snapshot identity at the SAME key/offset/length: must NOT return
        // the cached bytesA — its namespaced key misses and reads bytesB.
        const bucketB = makeMockBucket({ [KEY]: { bytes: bytesB, etag: 'eB' } });
        const b = await fetchR2RangeBytes(bucketB, KEY, 0, 8, 'identity-B');
        expect(new TextDecoder().decode(b)).toBe('BBBBBBBB');

        // And re-reading identity-A still returns A from cache (no cross-pollution).
        const a2 = await fetchR2RangeBytes(bucketA, KEY, 0, 8, 'identity-A');
        expect(new TextDecoder().decode(a2)).toBe('AAAAAAAA');
    });
});
