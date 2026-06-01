/**
 * Tests for V0.6 Sprint 2 B.2 bulk harvester orchestrator.
 * Network-free unit tests: chunk filename generation + worker partition logic.
 * (HTTP download + parse is exercised end-to-end via GHA workflow_dispatch.)
 */

import { describe, it, expect } from 'vitest';
import { generateChunkFilenames, partitionForWorker, decideExitCode } from '../../scripts/factory/bulk-pubchem-harvest.js';
import { buildGlobalIndex } from '../../scripts/factory/bulk-pubchem-shard.js';

describe('generateChunkFilenames', () => {
    it('produces 250 chunk filenames for ~125M total CIDs at 500K per chunk', () => {
        const chunks = generateChunkFilenames();
        expect(chunks.length).toBe(250);
    });

    it('first chunk covers CID 1-500000 with correct padding', () => {
        const chunks = generateChunkFilenames();
        expect(chunks[0]).toBe('Compound_000000001_000500000.sdf.gz');
    });

    it('second chunk covers CID 500001-1000000', () => {
        const chunks = generateChunkFilenames();
        expect(chunks[1]).toBe('Compound_000500001_001000000.sdf.gz');
    });

    it('last chunk covers up to ~125M', () => {
        const chunks = generateChunkFilenames();
        expect(chunks[chunks.length - 1]).toBe('Compound_124500001_125000000.sdf.gz');
    });

    it('chunks are unique and ordered', () => {
        const chunks = generateChunkFilenames();
        const set = new Set(chunks);
        expect(set.size).toBe(chunks.length);
        // Verify ordering by parsing first chunk index
        for (let i = 1; i < chunks.length; i++) {
            const prev = parseInt(chunks[i - 1].split('_')[1], 10);
            const cur = parseInt(chunks[i].split('_')[1], 10);
            expect(cur).toBeGreaterThan(prev);
        }
    });
});

describe('partitionForWorker', () => {
    it('shard 0 of 1 gets all chunks', () => {
        const all = generateChunkFilenames();
        const slice = partitionForWorker(all, 0, 1);
        expect(slice.length).toBe(all.length);
    });

    it('8-way matrix splits 250 chunks roughly evenly (31-32 each)', () => {
        const all = generateChunkFilenames();
        const slices = Array.from({ length: 8 }, (_, n) => partitionForWorker(all, n, 8));
        for (const slice of slices) {
            expect(slice.length).toBeGreaterThanOrEqual(31);
            expect(slice.length).toBeLessThanOrEqual(32);
        }
        const totalAssigned = slices.reduce((acc, s) => acc + s.length, 0);
        expect(totalAssigned).toBe(all.length); // no chunk missed
    });

    it('worker partitions are disjoint (no chunk appears in two workers)', () => {
        const all = generateChunkFilenames();
        const seen = new Set();
        for (let n = 0; n < 8; n++) {
            for (const chunk of partitionForWorker(all, n, 8)) {
                expect(seen.has(chunk)).toBe(false);
                seen.add(chunk);
            }
        }
        expect(seen.size).toBe(all.length);
    });

    it('different total counts work correctly', () => {
        const all = generateChunkFilenames();
        for (const total of [1, 2, 4, 8, 16]) {
            const totalAssigned = Array.from({ length: total }, (_, n) => partitionForWorker(all, n, total))
                .reduce((acc, s) => acc + s.length, 0);
            expect(totalAssigned).toBe(all.length);
        }
    });
});

describe('decideExitCode (LOCKED policy: finish all chunks, then non-zero if ANY unrecoverable)', () => {
    it('returns 0 when all chunks done and nothing failed', () => {
        expect(decideExitCode({ chunks_done: [{}], chunks_failed: [], unrecoverable_chunks: [] })).toBe(0);
    });

    it('returns 1 when ANY chunk is unrecoverable (even if others succeeded)', () => {
        expect(decideExitCode({
            chunks_done: [{}, {}], chunks_failed: [],
            unrecoverable_chunks: [{ chunk: 'Compound_x.sdf.gz', attempts: 5, last_error_class: 'UND_ERR_SOCKET' }],
        })).toBe(1);
    });

    it('keeps the legacy "all chunks failed -> exit 1" (no done, some failed)', () => {
        expect(decideExitCode({ chunks_done: [], chunks_failed: [{ chunk: 'x', error: 'HTTP 403' }], unrecoverable_chunks: [] })).toBe(1);
    });

    it('a parse/404 failure with other successes does NOT fail the worker (chunks_failed is soft)', () => {
        expect(decideExitCode({ chunks_done: [{}], chunks_failed: [{ chunk: 'x', error: 'parse: bad' }], unrecoverable_chunks: [] })).toBe(0);
    });
});

// Manifest-shape contract: processChunk pushes a structured entry into
// unrecoverable_chunks on retry-exhaustion, and main() sets complete from it.
describe('manifest complete / unrecoverable_chunks shape', () => {
    function deriveComplete(stats: any) {
        return stats.unrecoverable_chunks.length === 0;
    }
    it('complete:true when no unrecoverable chunks', () => {
        const stats = { unrecoverable_chunks: [] as any[] };
        expect(deriveComplete(stats)).toBe(true);
    });
    it('complete:false and unrecoverable_chunks populated with chunk/attempts/last_error_class', () => {
        const stats = {
            unrecoverable_chunks: [
                { chunk: 'Compound_000000001_000500000.sdf.gz', attempts: 5, last_error_class: 'UND_ERR_SOCKET', error: 'exhausted' },
            ],
        };
        expect(deriveComplete(stats)).toBe(false);
        const e = stats.unrecoverable_chunks[0];
        expect(e.chunk).toMatch(/^Compound_/);
        expect(e.attempts).toBe(5);
        expect(e.last_error_class).toBe('UND_ERR_SOCKET');
    });
});

// Fan-in coverage: build-index-only (buildGlobalIndex) must FAIL when any
// present worker manifest is complete:false -- no silent partial index.
describe('buildGlobalIndex fan-in completeness gate', () => {
    function fakeR2(manifests: Record<number, any>) {
        return {
            send: async (cmd: any) => {
                const key: string = cmd.input.Key;
                const m = key.match(/worker-(\d+)\.json$/);
                if (m) {
                    const w = Number(m[1]);
                    if (!(w in manifests)) { const e: any = new Error('NoSuchKey'); throw e; }
                    const body = Buffer.from(JSON.stringify(manifests[w]));
                    async function* iter() { yield body; }
                    return { Body: iter() };
                }
                return {}; // PutObject (index upload) -- no-op
            },
        } as any;
    }
    const completeManifest = (w: number) => ({
        worker_shard: w, total_records: 10, complete: true, unrecoverable_chunks: [],
        shards: [{ shard_id: `s${w}`, cid_range: [w * 1000, w * 1000 + 999], entity_count: 10 }],
    });
    const incompleteManifest = (w: number) => ({
        worker_shard: w, total_records: 5, complete: false,
        unrecoverable_chunks: [{ chunk: 'Compound_x.sdf.gz', attempts: 5, last_error_class: 'UND_ERR_SOCKET' }],
        shards: [{ shard_id: `s${w}`, cid_range: [w * 1000, w * 1000 + 499], entity_count: 5 }],
    });

    it('succeeds when all present workers are complete', async () => {
        const r2 = fakeR2({ 0: completeManifest(0), 1: completeManifest(1) });
        const index = await buildGlobalIndex(r2, 'bucket', 'bulk/pubchem/2026-06', 2, true);
        expect(index.workers_incomplete).toBe(0);
        expect(index.shard_count).toBe(2);
    });

    it('THROWS (fails the index build) when ANY present worker is complete:false', async () => {
        const r2 = fakeR2({ 0: completeManifest(0), 1: incompleteManifest(1) });
        await expect(buildGlobalIndex(r2, 'bucket', 'bulk/pubchem/2026-06', 2, true))
            .rejects.toThrow(/incomplete worker|partial index/i);
    });
});
