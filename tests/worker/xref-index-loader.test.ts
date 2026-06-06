// @ts-nocheck
/**
 * PR-COMPOUND-GUARD (Step-5a) — xref-index-loader OOM guards.
 *
 * The loader materializes ONLY the queried kind's Map (bounded memory), with
 * two hard OOM guards mirroring compound-manifest-loader: an XREF_MAX_BYTES
 * head().size refusal BEFORE the gunzip, and a MAX_XREF_ENTRIES per-kind cap.
 * Distinct snapshot dates per test so the per-isolate Map cache (key =
 * xref:<date>:<kind>) never short-circuits the guard.
 */

import { describe, it, expect, beforeAll } from 'vitest';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

function makeMockBucket(store: Record<string, { bytes: Uint8Array; etag: string }>) {
    return {
        async head(key: string) {
            const o = store[key];
            return o ? { size: o.bytes.length, etag: o.etag } : null;
        },
        async get(key: string) {
            const o = store[key];
            if (!o) return null;
            return {
                etag: o.etag,
                async arrayBuffer() {
                    return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength);
                },
            };
        },
    } as unknown as R2Bucket;
}

beforeAll(() => {
    if (typeof (globalThis as any).caches === 'undefined') {
        (globalThis as any).caches = { default: { async match() { return undefined; }, async put() { } } };
    }
});

describe('xref-index-loader OOM guards', () => {
    it('XREF_MAX_BYTES head().size guard throws BEFORE the gunzip', async () => {
        const { loadXrefKind, XREF_MAX_BYTES } = await import('../../src/worker/lib/xref-index-loader');
        const bucket = {
            async head() { return { size: XREF_MAX_BYTES + 1, etag: 'big' }; },
            async get() { throw new Error('should not be reached'); },
        } as unknown as R2Bucket;
        await expect(loadXrefKind(bucket, '2099-01-01', 'chembl_id')).rejects.toThrow(/OOM guard/);
    });

    it('MAX_XREF_ENTRIES per-kind cap throws', async () => {
        const { loadXrefKind, MAX_XREF_ENTRIES } = await import('../../src/worker/lib/xref-index-loader');
        const big: Record<string, number> = {};
        for (let i = 0; i <= MAX_XREF_ENTRIES; i++) big[`CHEMBL${i}`] = i + 1;
        const payload = JSON.stringify({ version: '1.0', index: { chembl_id: big } });
        const bucket = makeMockBucket({
            'snapshots/2099-01-02/xref-index.json.gz': { bytes: gzipSync(payload), etag: 'huge' },
        });
        await expect(loadXrefKind(bucket, '2099-01-02', 'chembl_id')).rejects.toThrow(/migration required/);
    });

    it('returns an empty Map when the queried kind is absent from the index', async () => {
        const { loadXrefKind } = await import('../../src/worker/lib/xref-index-loader');
        const payload = JSON.stringify({ version: '1.0', index: { chembl_id: { CHEMBL25: 2244 } } });
        const bucket = makeMockBucket({
            'snapshots/2099-01-03/xref-index.json.gz': { bytes: gzipSync(payload), etag: 'x' },
        });
        const map = await loadXrefKind(bucket, '2099-01-03', 'rxcui');
        expect(map.size).toBe(0);
    });
});
