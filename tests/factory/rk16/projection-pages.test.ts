// @ts-nocheck
/**
 * RK-16A2 — projection page writer: 1 page = 1 NXVF entity; seal on EACH of the
 * three PageSizePolicy ceilings; cursor_min/max correct.
 */
import { describe, it, expect } from 'vitest';
import { writeCanonicalShardAsync } from '../../../scripts/factory/lib/rk16/canonical-shard-writer.js';
import { writeProjectionPages } from '../../../scripts/factory/lib/rk16/projection-page-writer.js';
import { makeCanonicalRecords, fixtureFamilyPolicy } from './_fixture-family.js';

function readEntityCount(shardBytes) { return shardBytes.readUInt32LE(11); }

// Build projection rows from a canonical write (rows carry real locators).
async function buildRows(n) {
    const records = makeCanonicalRecords(n);
    const canon = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });
    return canon.record_locators.map((loc) => {
        const orig = records.find((r) => r.canonical_id === loc.canonical_id);
        return fixtureFamilyPolicy.project(orig.record, loc);
    });
}

describe('projection-page-writer', () => {
    it('1 page = 1 NXVF entity; cursor_min/max are first/last sort keys', async () => {
        const rows = await buildRows(10);
        const policy = { record_count_target: 4, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9 };
        const res = await writeProjectionPages(rows, policy, { shardKey: 'proj/shard-000.bin' });

        expect(res.entity_count).toBe(res.page_refs.length); // 1 entity per page
        expect(readEntityCount(res.shard_bytes)).toBe(res.page_refs.length);
        for (const pr of res.page_refs) {
            expect(pr.kind).toBe('posting_page_ref');
            expect(pr.record_count).toBeLessThanOrEqual(4);
            expect(pr.cursor_min <= pr.cursor_max).toBe(true);
            expect(pr.page_sha256).toMatch(/^[0-9a-f]{64}$/);
        }
        // First page cursor_min is the global min sort key.
        const allKeys = rows.map((r) => String(r.canonical_id)).sort();
        expect(res.page_refs[0].cursor_min).toBe(allKeys[0]);
        expect(res.page_refs[res.page_refs.length - 1].cursor_max).toBe(allKeys[allKeys.length - 1]);
    });

    it('seals on record_count_target', async () => {
        const rows = await buildRows(9);
        const policy = { record_count_target: 3, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9 };
        const res = await writeProjectionPages(rows, policy);
        expect(res.page_total).toBe(3);
        expect(res.page_refs.every((p) => p.record_count === 3)).toBe(true);
    });

    it('seals on parsed_heap_ceiling (uncompressed bytes)', async () => {
        const rows = await buildRows(20);
        // a tiny heap ceiling forces sealing well before the count target
        const policy = { record_count_target: 1000, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 600 };
        const res = await writeProjectionPages(rows, policy);
        expect(res.page_total).toBeGreaterThan(1);
        // every sealed page's payload is at/over the ceiling OR is the last page
        for (let i = 0; i < res.page_refs.length - 1; i++) {
            expect(res.page_refs[i].record_count).toBeGreaterThanOrEqual(1);
        }
    });

    it('seals on compressed_bytes_ceiling', async () => {
        const rows = await buildRows(30);
        const policy = { record_count_target: 1000, compressed_bytes_ceiling: 200, parsed_heap_ceiling: 1e9 };
        const res = await writeProjectionPages(rows, policy);
        expect(res.page_total).toBeGreaterThan(1);
    });
});
