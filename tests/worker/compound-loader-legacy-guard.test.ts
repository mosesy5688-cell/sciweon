// @ts-nocheck
/**
 * PR-COMPOUND-GUARD (Step-5a) Part 3 — loadTier1Legacy head().size guard.
 *
 * loadTier1Legacy is the deploy-transition FALLBACK (no compounds_manifest_key);
 * it gunzips the WHOLE compounds-enriched file into the 128MB isolate. The
 * COMPOUNDS_MAX_BYTES head().size guard refuses an oversized file with a LOUD
 * throw (the caller surfaces a 503) instead of an OOM. The guard error
 * PROPAGATES out of loadTier1 (it must not be swallowed into a false null/404).
 * COMPOUNDS_MAX_BYTES is env-overridable.
 */

import { describe, it, expect } from 'vitest';
import { loadTier1, COMPOUNDS_MAX_BYTES } from '../../src/worker/lib/compound-loader';

function makeMockBucket(store: Record<string, { size: number; bytes?: Uint8Array; etag: string }>) {
    return {
        async head(key: string) {
            const o = store[key];
            return o ? { size: o.size, etag: o.etag } : null;
        },
        async get(key: string) {
            const o = store[key];
            if (!o || !o.bytes) return null;
            return {
                etag: o.etag,
                async arrayBuffer() {
                    return o.bytes!.buffer.slice(o.bytes!.byteOffset, o.bytes!.byteOffset + o.bytes!.byteLength);
                },
            };
        },
    } as unknown as R2Bucket;
}

function gz(text: string): Uint8Array {
    const { gzipSync } = require('zlib');
    return new Uint8Array(gzipSync(Buffer.from(text, 'utf-8')));
}

const DATE = '2026-05-19';
const PTR = new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: DATE }));
// no compounds_manifest_key -> loadTier1Sharded throws -> legacy fallback engaged.

describe('loadTier1Legacy COMPOUNDS_MAX_BYTES guard', () => {
    it('THROWS LOUD when the legacy .gz head().size exceeds the ceiling', async () => {
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [`snapshots/${DATE}/compounds-enriched.jsonl.gz`]: {
                size: COMPOUNDS_MAX_BYTES + 1, bytes: gz('{}'), etag: 'big',
            },
        });
        await expect(loadTier1({ SCIWEON_R2: bucket } as any, 2244)).rejects.toThrow(/OOM guard|COMPOUNDS_MAX_BYTES/);
    });

    it('a within-ceiling legacy file loads normally (CID found)', async () => {
        const jsonl = JSON.stringify({ pubchem_cid: 2244, id: 'x' });
        const bytes = gz(jsonl);
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [`snapshots/${DATE}/compounds-enriched.jsonl.gz`]: { size: bytes.length, bytes, etag: 'ok' },
        });
        const rec = await loadTier1({ SCIWEON_R2: bucket } as any, 2244);
        expect(rec?.pubchem_cid).toBe(2244);
    });

    it('env COMPOUNDS_MAX_BYTES override tightens the ceiling', async () => {
        const jsonl = JSON.stringify({ pubchem_cid: 2244, id: 'x' });
        const bytes = gz(jsonl);
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [`snapshots/${DATE}/compounds-enriched.jsonl.gz`]: { size: bytes.length, bytes, etag: 'ok' },
        });
        // override to 1 byte -> the (tiny but >1B) file is now over the ceiling.
        const env = { SCIWEON_R2: bucket, COMPOUNDS_MAX_BYTES: '1' } as any;
        await expect(loadTier1(env, 2244)).rejects.toThrow(/OOM guard|COMPOUNDS_MAX_BYTES/);
    });
});
