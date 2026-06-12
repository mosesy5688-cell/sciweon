// @ts-nocheck
/**
 * RK-13 (SOURCE_FAILURE_CONTRACT, N-10) — paper-loader source-failure guard.
 *
 * A source READ failure (pointer fetch / gunzip / object-missing) must NOT be
 * served as an indistinguishable []; it must throw a typed SourceLoadError the
 * caller maps to a retryable 502/503. The genuine queried_clean case still
 * resolves [] (the CRITICAL regression guard).
 */

import { describe, it, expect } from 'vitest';
import { loadPapersForCompound } from '../../src/worker/lib/paper-loader';
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
const PAPERS_KEY = `snapshots/${DATE}/papers.jsonl.gz`;

describe('paper-loader RK-13 source-failure', () => {
    it('fetch-failure (pointer missing) -> throws SourceLoadError(source_unavailable)', async () => {
        const bucket = makeMockBucket({}); // even latest.json absent -> head null -> not found
        await expect(loadPapersForCompound(bucket, CID)).rejects.toBeInstanceOf(SourceLoadError);
        await expect(loadPapersForCompound(bucket, CID)).rejects.toMatchObject({
            source: 'papers', failure_class: 'source_unavailable', retryable: true,
        });
    });

    it('parse-failure (corrupt .gz) -> throws SourceLoadError(parse_failed, non-retryable)', async () => {
        const corrupt = new Uint8Array([1, 2, 3, 4, 5]); // not a valid gzip stream
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [PAPERS_KEY]: { size: corrupt.length, bytes: corrupt, etag: 'bad' },
        });
        const err = await loadPapersForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.failure_class).toBe('parse_failed');
        expect(err.retryable).toBe(false);
    });

    it('object-missing (papers.gz absent) -> throws SourceLoadError(source_unavailable)', async () => {
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            // papers.jsonl.gz intentionally absent
        });
        const err = await loadPapersForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.failure_class).toBe('source_unavailable');
        expect(err.retryable).toBe(true);
    });

    it('CRITICAL: true-empty (queried_clean) -> resolves [] (NOT throw)', async () => {
        // A well-formed file that simply mentions no matching compound.
        // NOTE: r2-fetch caches per (key, etag) at module scope, so each test
        // uses a UNIQUE etag to avoid serving another test's bytes.
        const lines = JSON.stringify({ id: 'P1', mentioned_compounds: [{ compound_id: 'CID:9999' }] });
        const bytes = gz(lines + '\n');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [PAPERS_KEY]: { size: bytes.length, bytes, etag: 'clean' },
        });
        const recs = await loadPapersForCompound(bucket, CID);
        expect(Array.isArray(recs)).toBe(true);
        expect(recs).toHaveLength(0);
    });

    it('success -> returns the matching record', async () => {
        const lines = [
            JSON.stringify({ id: 'P1', mentioned_compounds: [{ compound_id: CID }] }),
            JSON.stringify({ id: 'P2', mentioned_compounds: [{ compound_id: 'CID:9999' }] }),
        ].join('\n');
        const bytes = gz(lines + '\n');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [PAPERS_KEY]: { size: bytes.length, bytes, etag: 'success' },
        });
        const recs = await loadPapersForCompound(bucket, CID);
        expect(recs).toHaveLength(1);
        expect(recs[0].id).toBe('P1');
    });
});
