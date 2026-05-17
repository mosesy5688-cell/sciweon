/**
 * Tests for V0.6 Sprint 2 B.2 bulk harvester orchestrator.
 * Network-free unit tests: chunk filename generation + worker partition logic.
 * (HTTP download + parse is exercised end-to-end via GHA workflow_dispatch.)
 */

import { describe, it, expect } from 'vitest';
import { generateChunkFilenames, partitionForWorker } from '../../scripts/factory/bulk-pubchem-harvest.js';

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
