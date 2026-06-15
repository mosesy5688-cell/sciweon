// @ts-nocheck
/**
 * RK-16A2 — determinism: same producer tuple + same input -> byte-identical
 * rebuild of the shard. Also proves projection == project(canonical) re-derives
 * identically and projection_hash is stable.
 */
import { describe, it, expect } from 'vitest';
import { writeCanonicalShardAsync } from '../../../scripts/factory/lib/rk16/canonical-shard-writer.js';
import { writeProjectionPages } from '../../../scripts/factory/lib/rk16/projection-page-writer.js';
import { projectionHash } from '../../../scripts/factory/lib/rk16/content-hash.js';
import { makeCanonicalRecords, fixtureFamilyPolicy } from './_fixture-family.js';

describe('determinism', () => {
    it('same input -> byte-identical canonical shard rebuild', async () => {
        const records = makeCanonicalRecords(12);
        const a = await writeCanonicalShardAsync(records, { shardKey: 'k' });
        const b = await writeCanonicalShardAsync(records, { shardKey: 'k' });
        expect(Buffer.compare(a.shard_bytes, b.shard_bytes)).toBe(0);
        expect(a.shard_hashes).toEqual(b.shard_hashes);
        expect(a.record_locators).toEqual(b.record_locators);
    });

    it('same input -> byte-identical projection shard rebuild', async () => {
        const records = makeCanonicalRecords(15);
        const canon = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });
        const rows = canon.record_locators.map((loc) => {
            const orig = records.find((r) => r.canonical_id === loc.canonical_id);
            return fixtureFamilyPolicy.project(orig.record, loc);
        });
        const policy = { record_count_target: 4, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9 };
        const a = await writeProjectionPages(rows, policy, { shardKey: 'proj/shard-000.bin' });
        const b = await writeProjectionPages(rows, policy, { shardKey: 'proj/shard-000.bin' });
        expect(Buffer.compare(a.shard_bytes, b.shard_bytes)).toBe(0);
        expect(a.page_refs).toEqual(b.page_refs);
    });

    it('projection == project(canonical, policy) re-derives identically; projection_hash stable', async () => {
        const records = makeCanonicalRecords(5);
        const canon = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });
        for (const loc of canon.record_locators) {
            const orig = records.find((r) => r.canonical_id === loc.canonical_id);
            const row1 = fixtureFamilyPolicy.project(orig.record, loc);
            const row2 = fixtureFamilyPolicy.project(orig.record, loc);
            expect(row1).toEqual(row2); // pure, reproducible
            // projection_hash is the sha256 of the row's canonical bytes (minus the hash field)
            const { projection_hash: _drop, ...bare } = row1;
            expect(row1.projection_hash).toBe(projectionHash(bare));
            // row binds to the canonical record's content hash
            expect(row1.canonical_content_hash).toBe(loc.content_hash);
        }
    });
});
