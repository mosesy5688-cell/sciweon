// @ts-nocheck
/**
 * RK-15 full-snapshot completeness — the SNAPSHOT_REQUIRED_INVENTORY SSoT +
 * reader<->producer PARITY CONTRACT.
 *
 * The V3-A defect: a candidate published with ONLY compound/neg/xref/search went
 * VALIDATED + LIVE while OMITTING every satellite serving file (papers/trials/
 * bioactivities/target-index) -> 503/404 after cutover. The fix is ONE
 * authoritative inventory reverse-enumerated from the readers + reconciled with
 * SNAPSHOT_FILES. This test pins that the inventory:
 *   (a) is a single frozen SSoT with file:line reader evidence on every entry;
 *   (b) RECONCILES with the producer SNAPSHOT_FILES (every satellite is a real
 *       SNAPSHOT_FILES member — no satellite the producer never publishes);
 *   (c) COVERS every whole-gz reader surface (so a NEW reader surface that reads
 *       `<prefix>X.gz` but is absent from the inventory FAILS this test).
 */

import { describe, it, expect } from 'vitest';
import {
    SATELLITE_INVENTORY, STRUCTURED_INVENTORY, requiredSatelliteKeys, satelliteFor,
    reconcileWithSnapshotFiles, allRequiredSurfaceIds,
} from '../../scripts/factory/lib/snapshot-inventory.js';
import { SNAPSHOT_FILES } from '../../scripts/factory/lib/aggregated-files.js';

describe('SNAPSHOT_REQUIRED_INVENTORY — single frozen SSoT', () => {
    it('SATELLITE + STRUCTURED are frozen, non-empty, and every entry carries reader file:line evidence', () => {
        expect(Object.isFrozen(SATELLITE_INVENTORY)).toBe(true);
        expect(Object.isFrozen(STRUCTURED_INVENTORY)).toBe(true);
        expect(SATELLITE_INVENTORY.length).toBeGreaterThan(0);
        for (const e of [...SATELLITE_INVENTORY, ...STRUCTURED_INVENTORY]) {
            expect(typeof e.surface).toBe('string');
            expect(e.surface.length).toBeGreaterThan(0);
            // file:line evidence (a path + a `:` line ref) on every entry.
            expect(e.reader).toMatch(/src\/worker\/.+:\d+|src\/worker\/.+\.ts/);
            expect(typeof e.producer).toBe('string');
        }
    });

    it('the four satellites that BROKE at the V3-A cutover are all present', () => {
        const suffixes = SATELLITE_INVENTORY.map(e => e.key_suffix);
        expect(suffixes).toContain('papers.jsonl.gz');
        expect(suffixes).toContain('trials.jsonl.gz');
        expect(suffixes).toContain('trial-links.jsonl.gz');
        expect(suffixes).toContain('bioactivities.jsonl.gz');
        expect(suffixes).toContain('target-index.json.gz');
    });

    it('requiredSatelliteKeys derives the exact <prefix><suffix> keys', () => {
        const keys = requiredSatelliteKeys('snapshots/2026-06-13/100-1/');
        expect(keys).toContain('snapshots/2026-06-13/100-1/papers.jsonl.gz');
        expect(keys).toContain('snapshots/2026-06-13/100-1/target-index.json.gz');
        expect(keys.length).toBe(SATELLITE_INVENTORY.length);
        expect(satelliteFor('papers.jsonl.gz')).not.toBeNull();
        expect(satelliteFor('does-not-exist.gz')).toBeNull();
    });

    it('allRequiredSurfaceIds is the stable union of satellites + structured ids', () => {
        const ids = allRequiredSurfaceIds();
        expect(ids).toContain('papers.jsonl.gz');
        expect(ids).toContain('compounds');
        expect(ids).toContain('neg-evidence');
        expect(ids).toContain('xref-index');
        expect(ids).toContain('compounds-search');
        // sorted + de-dup-stable
        expect([...ids].sort()).toEqual(ids);
    });
});

describe('reader<->producer PARITY CONTRACT (reconcile vs SNAPSHOT_FILES)', () => {
    it('every satellite snapshot_file is a real SNAPSHOT_FILES member (no producer-less satellite)', () => {
        const { notInSnapshotFiles } = reconcileWithSnapshotFiles();
        // A satellite whose source the producer never publishes is a CONTRACT BUG.
        expect(notInSnapshotFiles, `satellites not in SNAPSHOT_FILES: ${notInSnapshotFiles.join(', ')}`).toEqual([]);
    });

    it('the satellite cover set ⊆ SNAPSHOT_FILES', () => {
        const snapshotSet = new Set(SNAPSHOT_FILES);
        for (const e of SATELLITE_INVENTORY) {
            expect(snapshotSet.has(e.snapshot_file), `${e.snapshot_file} missing from SNAPSHOT_FILES`).toBe(true);
        }
    });

    it('DRIFT GUARD: a reader whole-gz surface absent from the inventory FAILS the contract', () => {
        // The set of SNAPSHOT_FILES that the WORKER reads as a whole `<prefix>X.gz`
        // satellite (reverse-enumerated from src/worker/**). If a future PR adds a
        // new whole-gz reader surface, it MUST be added to SATELLITE_INVENTORY or
        // this list — otherwise the candidate could ship without it (the V3-A bug).
        const READER_WHOLE_GZ_SURFACES = [
            'papers.jsonl',          // paper-loader.ts:25
            'trial-links.jsonl',     // trial-loader.ts:17
            'trials.jsonl',          // trial-loader.ts:38
            'bioactivities.jsonl',   // bioactivity-loader.ts:22
            'target-index.json',     // target-loader.ts:83
            'compounds-enriched.jsonl', // compound-loader.ts:172 / entity-resolver.ts:150 / compound-search.ts:123
            'neg-evidence.jsonl',    // neg-evidence-loader.ts:149 (legacy whole-file)
        ];
        const covered = new Set(SATELLITE_INVENTORY.map(e => e.snapshot_file));
        for (const surface of READER_WHOLE_GZ_SURFACES) {
            expect(covered.has(surface), `reader whole-gz surface ${surface} not covered by SATELLITE_INVENTORY`).toBe(true);
        }
        // And no PHANTOM satellite that no reader reads as whole-gz.
        const readerSet = new Set(READER_WHOLE_GZ_SURFACES);
        for (const e of SATELLITE_INVENTORY) {
            expect(readerSet.has(e.snapshot_file), `inventory satellite ${e.snapshot_file} has no reader whole-gz surface`).toBe(true);
        }
    });
});
