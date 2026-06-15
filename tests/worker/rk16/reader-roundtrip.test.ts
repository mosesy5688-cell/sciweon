// @ts-nocheck
/**
 * RK-16A2 — reader round-trip: write (producer) -> read (worker TS reader) ->
 * deep-equals original; integrity hashes verify; mismatch -> reader throws.
 *
 * Offline/fixture only: producer writes to a temp dir + returns in-memory bytes;
 * the reader operates on those bytes. env stub {SHARD_AES_KEY: undefined} so
 * decryptPayload is passthrough.
 */
import { describe, it, expect } from 'vitest';
import { writeCanonicalShardAsync } from '../../../scripts/factory/lib/rk16/canonical-shard-writer.js';
import { writeProjectionPages } from '../../../scripts/factory/lib/rk16/projection-page-writer.js';
import { writePostingList } from '../../../scripts/factory/lib/rk16/posting-directory-writer.js';
import { makeCanonicalRecords, fixtureFamilyPolicy } from '../../factory/rk16/_fixture-family.js';
import { readCanonicalRecord } from '../../../src/worker/lib/rk16/canonical-reader';
import { readProjectionPage } from '../../../src/worker/lib/rk16/projection-reader';
import { readPostingDirectory } from '../../../src/worker/lib/rk16/directory-reader';

const ENV = { SHARD_AES_KEY: undefined };

function makePageRefs(n) {
    const refs = [];
    for (let i = 0; i < n; i++) {
        refs.push({
            kind: 'posting_page_ref', shard_key: 's', page_offset: i * 10, page_length: 10,
            record_count: 1, cursor_min: `K${String(i).padStart(4, '0')}`,
            cursor_max: `K${String(i).padStart(4, '0')}`, page_sha256: 'f'.repeat(64),
        });
    }
    return refs;
}

describe('rk16 reader round-trip', () => {
    it('canonical: each record reads back deep-equal by RecordLocator', async () => {
        const records = makeCanonicalRecords(8);
        const canon = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });
        const bytes = new Uint8Array(canon.shard_bytes);
        for (const loc of canon.record_locators) {
            const read = await readCanonicalRecord(bytes, loc, ENV);
            const orig = records.find((r) => r.canonical_id === loc.canonical_id);
            expect(read).toEqual(orig.record);
        }
    });

    it('canonical: content_hash mismatch -> reader throws', async () => {
        const records = makeCanonicalRecords(2);
        const canon = await writeCanonicalShardAsync(records);
        const bytes = new Uint8Array(canon.shard_bytes);
        const bad = { ...canon.record_locators[0], content_hash: 'a'.repeat(64) };
        await expect(readCanonicalRecord(bytes, bad, ENV)).rejects.toThrow(/content_hash mismatch/i);
    });

    it('projection: page reads back rows; cursor bounds round-trip', async () => {
        const records = makeCanonicalRecords(10);
        const canon = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });
        const rows = canon.record_locators.map((loc) => {
            const o = records.find((r) => r.canonical_id === loc.canonical_id);
            return fixtureFamilyPolicy.project(o.record, loc);
        });
        const policy = { record_count_target: 4, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9 };
        const proj = await writeProjectionPages(rows, policy, { shardKey: 'proj/shard-000.bin' });
        const bytes = new Uint8Array(proj.shard_bytes);
        const firstPage = await readProjectionPage(bytes, proj.page_refs[0], ENV);
        expect(firstPage.length).toBe(proj.page_refs[0].record_count);
        expect(String(firstPage[0].canonical_id)).toBe(proj.page_refs[0].cursor_min);
    });

    it('projection: page_sha256 mismatch -> reader throws', async () => {
        const records = makeCanonicalRecords(4);
        const canon = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });
        const rows = canon.record_locators.map((loc) => {
            const o = records.find((r) => r.canonical_id === loc.canonical_id);
            return fixtureFamilyPolicy.project(o.record, loc);
        });
        const proj = await writeProjectionPages(rows, { record_count_target: 100, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9 });
        const bytes = new Uint8Array(proj.shard_bytes);
        const bad = { ...proj.page_refs[0], page_sha256: 'b'.repeat(64) };
        await expect(readProjectionPage(bytes, bad, ENV)).rejects.toThrow(/page_sha256 mismatch/i);
    });

    it('directory: page refs round-trip; directory_sha256 mismatch -> throws', async () => {
        const refs = makePageRefs(65); // forces two-level
        const res = await writePostingList(refs, { directoryShardKey: 'dir/shard-000.bin' });
        expect(res.two_level).toBe(true);
        const bytes = new Uint8Array(res.directory_bytes);
        const back = await readPostingDirectory(bytes, res.posting_list, ENV);
        expect(back).toEqual(refs);

        const bad = { ...res.posting_list, directory_sha256: 'c'.repeat(64) };
        await expect(readPostingDirectory(bytes, bad, ENV)).rejects.toThrow(/directory_sha256 mismatch/i);
    });
});
