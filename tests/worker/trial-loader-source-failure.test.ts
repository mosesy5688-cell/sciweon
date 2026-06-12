// @ts-nocheck
/**
 * RK-13 (SOURCE_FAILURE_CONTRACT, N-10) — trial-loader source-failure guard.
 *
 * The trial loader reads TWO source objects (trial-links.jsonl.gz then
 * trials.jsonl.gz). A READ failure of EITHER must throw a typed SourceLoadError,
 * not an indistinguishable []. The genuine queried_clean cases (no matching NCT
 * link, or matching NCT but no matching trial) still resolve [] (the CRITICAL
 * regression guard).
 */

import { describe, it, expect } from 'vitest';
import { loadTrialsForCompound } from '../../src/worker/lib/trial-loader';
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
const LINKS_KEY = `snapshots/${DATE}/trial-links.jsonl.gz`;
const TRIALS_KEY = `snapshots/${DATE}/trials.jsonl.gz`;

const linkGz = (nct: string) => gz(JSON.stringify({ compound_id: CID, nct_id: nct }) + '\n');

// r2-fetch caches per (key, etag) at module scope; each test uses UNIQUE etags
// so a later test never reads an earlier test's cached bytes.
describe('trial-loader RK-13 source-failure', () => {
    it('fetch-failure (links object missing) -> throws SourceLoadError(source_unavailable)', async () => {
        // pointer present but trial-links.gz absent -> first read fails.
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
        });
        const err = await loadTrialsForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.source).toBe('trials');
        expect(err.failure_class).toBe('source_unavailable');
        expect(err.retryable).toBe(true);
    });

    it('parse-failure (corrupt links .gz) -> throws SourceLoadError(parse_failed)', async () => {
        const corrupt = new Uint8Array([0, 1, 2, 3]);
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [LINKS_KEY]: { size: corrupt.length, bytes: corrupt, etag: 'bad' },
        });
        const err = await loadTrialsForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.failure_class).toBe('parse_failed');
        expect(err.retryable).toBe(false);
    });

    it('object-missing (links yield NCT but trials.gz absent) -> SourceLoadError(source_unavailable)', async () => {
        const links = linkGz('NCT001');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [LINKS_KEY]: { size: links.length, bytes: links, etag: 'l-miss' },
            // trials.jsonl.gz intentionally absent
        });
        const err = await loadTrialsForCompound(bucket, CID).catch(e => e);
        expect(err).toBeInstanceOf(SourceLoadError);
        expect(err.failure_class).toBe('source_unavailable');
    });

    it('CRITICAL: true-empty, no matching NCT link (queried_clean) -> resolves [] (NOT throw)', async () => {
        const links = gz(JSON.stringify({ compound_id: 'CID:9999', nct_id: 'NCT777' }) + '\n');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [LINKS_KEY]: { size: links.length, bytes: links, etag: 'l-clean1' },
            // trials.gz never read (nctIds empty) -> [] without touching it.
        });
        const recs = await loadTrialsForCompound(bucket, CID);
        expect(Array.isArray(recs)).toBe(true);
        expect(recs).toHaveLength(0);
    });

    it('CRITICAL: true-empty, NCT linked but no matching trial (queried_clean) -> resolves []', async () => {
        const links = linkGz('NCT001');
        const trials = gz(JSON.stringify({ nct_id: 'NCT999', status: 'COMPLETED' }) + '\n');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [LINKS_KEY]: { size: links.length, bytes: links, etag: 'l-clean2' },
            [TRIALS_KEY]: { size: trials.length, bytes: trials, etag: 't-clean2' },
        });
        const recs = await loadTrialsForCompound(bucket, CID);
        expect(recs).toHaveLength(0);
    });

    it('success -> returns the matching trial record', async () => {
        const links = linkGz('NCT001');
        const trials = [
            JSON.stringify({ nct_id: 'NCT001', status: 'RECRUITING', phase: 2 }),
            JSON.stringify({ nct_id: 'NCT999', status: 'COMPLETED' }),
        ].join('\n');
        const trialsGz = gz(trials + '\n');
        const bucket = makeMockBucket({
            'snapshots/latest.json': { size: PTR.length, bytes: PTR, etag: 'p' },
            [LINKS_KEY]: { size: links.length, bytes: links, etag: 'l-ok' },
            [TRIALS_KEY]: { size: trialsGz.length, bytes: trialsGz, etag: 't-ok' },
        });
        const recs = await loadTrialsForCompound(bucket, CID);
        expect(recs).toHaveLength(1);
        expect(recs[0].nct_id).toBe('NCT001');
    });
});
