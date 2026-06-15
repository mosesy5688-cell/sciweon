// @ts-nocheck
/**
 * RK-16A2 — canonical shard writer: 1 record = 1 NXVF entity, sorted, hashed.
 */
import { describe, it, expect } from 'vitest';
import { writeCanonicalShardAsync } from '../../../scripts/factory/lib/rk16/canonical-shard-writer.js';
import { contentHash } from '../../../scripts/factory/lib/rk16/content-hash.js';
import { makeCanonicalRecords } from './_fixture-family.js';

// NXVF V4.1 header (29B) reader: EntityCount lives at byte 11 (uint32 LE).
function readEntityCount(shardBytes) {
    return shardBytes.readUInt32LE(11);
}

describe('canonical-shard-writer', () => {
    it('writes one NXVF entity per record (EntityCount === N) and sorts by canonical_id', async () => {
        const records = makeCanonicalRecords(7);
        const res = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });

        expect(res.record_total).toBe(7);
        expect(res.entity_count).toBe(7);
        expect(res.record_locators).toHaveLength(7);
        expect(readEntityCount(res.shard_bytes)).toBe(7);

        // Locators are emitted in canonical_id ascending order.
        const ids = res.record_locators.map((l) => l.canonical_id);
        expect(ids).toEqual([...ids].sort());

        // Each locator is a well-formed RecordLocator with a canonical content_hash.
        for (const loc of res.record_locators) {
            expect(loc.kind).toBe('record_locator');
            expect(loc.shard_key).toBe('canon/shard-000.bin');
            expect(typeof loc.byte_offset).toBe('number');
            expect(typeof loc.byte_length).toBe('number');
            expect(loc.content_hash).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it('content_hash equals contentHash() of the canonical record bytes', async () => {
        const records = makeCanonicalRecords(3);
        const res = await writeCanonicalShardAsync(records);
        for (const loc of res.record_locators) {
            const orig = records.find((r) => r.canonical_id === loc.canonical_id);
            expect(loc.content_hash).toBe(contentHash(orig.record));
        }
    });

    it('byte offsets are monotonically increasing (non-overlapping entities)', async () => {
        const res = await writeCanonicalShardAsync(makeCanonicalRecords(5));
        const locs = res.record_locators;
        for (let i = 1; i < locs.length; i++) {
            expect(locs[i].byte_offset).toBeGreaterThanOrEqual(
                locs[i - 1].byte_offset + locs[i - 1].byte_length,
            );
        }
    });
});
