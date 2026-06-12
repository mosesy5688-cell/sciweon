// @ts-nocheck
/**
 * RK-13 (SOURCE_FAILURE_CONTRACT, N-10) — bioactivity-loader source-failure guard.
 *
 * A source READ failure must NOT be served as an indistinguishable []; it must
 * throw a typed SourceLoadError. The genuine queried_clean case still resolves
 * [] (the CRITICAL regression guard).
 */

import { describe, it, expect } from 'vitest';
import { loadBioactivitiesForCompound } from '../../src/worker/lib/bioactivity-loader';
import { SourceLoadError } from '../../src/worker/lib/source-load-error';

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

const DATE = '2026-06-12';
const PTR = new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: DATE }));
const CID = 'CID:2244';
const BIO_KEY = `snapshots/${DATE}/bioactivities.jsonl.gz`;

describe('bioactivity-loader RK-13 source-failure', () => {
    it('fetch-failure (pointer missing) -> throws SourceLoadError(source_unavailable)', async () => {
        const bucket = makeMockBucket({});
        const err = await loadBioactivitiesForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.source).toBe('bioactivities');
        expect(err.failure_class).toBe('source_unavailable');
        expect(err.retryable).toBe(true);
    });

    it('parse-failure (corrupt .gz) -> throws SourceLoadError(parse_failed, non-retryable)', async () => {
        const corrupt = new Uint8Array([9, 8, 7, 6]);
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [BIO_KEY]: { size: corrupt.length, bytes: corrupt, etag: 'bad' },
        });
        const err = await loadBioactivitiesForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.failure_class).toBe('parse_failed');
        expect(err.retryable).toBe(false);
    });

    it('object-missing (bioactivities.gz absent) -> throws SourceLoadError(source_unavailable)', async () => {
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
        });
        const err = await loadBioactivitiesForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.failure_class).toBe('source_unavailable');
    });

    it('CRITICAL: true-empty (queried_clean) -> resolves [] (NOT throw)', async () => {
        // Unique etag per test: r2-fetch caches per (key, etag) at module scope.
        const lines = JSON.stringify({ id: 'B1', compound_id: 'CID:9999' });
        const bytes = gz(lines + '\n');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [BIO_KEY]: { size: bytes.length, bytes, etag: 'clean' },
        });
        const recs = await loadBioactivitiesForCompound(bucket, CID);
        expect(Array.isArray(recs)).toBe(true);
        expect(recs).toHaveLength(0);
    });

    it('success -> returns the matching record', async () => {
        const lines = [
            JSON.stringify({ id: 'B1', compound_id: CID, is_active: true }),
            JSON.stringify({ id: 'B2', compound_id: 'CID:9999' }),
        ].join('\n');
        const bytes = gz(lines + '\n');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [BIO_KEY]: { size: bytes.length, bytes, etag: 'success' },
        });
        const recs = await loadBioactivitiesForCompound(bucket, CID);
        expect(recs).toHaveLength(1);
        expect(recs[0].id).toBe('B1');
    });
});
