// @ts-nocheck
/**
 * RK-16A3 — generic activation GRAPH probe: happy path + fail-loud per hop.
 *
 * Builds a COMPLETE fixture posting family (canonical shards + projection pages +
 * two-level directory) with a CLEAN referential-integrity attestation bound into
 * a fixture seal, then asserts probeActivationGraph passes; and that EACH hop
 * (missing object / sha256 mismatch / NXVF decode failure / canonical_id mismatch
 * / attestation != seal) throws [ACTIVATE].
 */

import { describe, it, expect } from 'vitest';
import { probeActivationGraph } from '../../../scripts/factory/lib/rk16/activation-graph-probe.js';
import { buildGraphFamilyFixture, FAMILY_ID, makeGraphMock } from './_graph-fixture.js';
import { writeCanonicalShardAsync } from '../../../scripts/factory/lib/rk16/canonical-shard-writer.js';
import { writeProjectionPages } from '../../../scripts/factory/lib/rk16/projection-page-writer.js';
import { makeCanonicalRecords, fixtureFamilyPolicy } from './_fixture-family.js';

async function run(fix, overrides = {}) {
    return probeActivationGraph({
        client: fix.mock, bucket: 'b', objectPrefix: fix.prefix,
        familyDescriptor: fix.descriptor, seal: fix.seal, ...overrides,
    });
}

describe('RK-16A3 — activation graph probe (HAPPY PATH)', () => {
    it('walks family manifest -> directory -> page -> projection row -> RecordLocator -> canonical record', async () => {
        const fix = await buildGraphFamilyFixture();
        await expect(run(fix)).resolves.toBeUndefined();
    });
});

describe('RK-16A3 — activation graph probe (FAIL-LOUD, one per hop)', () => {
    it('missing family manifest -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        fix.mock.store.delete(fix.manifestKey);
        await expect(run(fix)).rejects.toThrow(/\[ACTIVATE\] graph hop "family_manifest" object missing/);
    });

    it('attestation_hash missing from manifest -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        const m = { ...fix.manifest }; delete m.referential_integrity_attestation_hash;
        fix.mock.store.set(fix.manifestKey, { body: JSON.stringify(m) });
        await expect(run(fix)).rejects.toThrow(/manifest missing referential_integrity_attestation_hash/);
    });

    it('attestation_hash != seal -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        const badSeal = { posting_family_attestations: { [FAMILY_ID]: 'a'.repeat(64) } };
        await expect(run(fix, { seal: badSeal })).rejects.toThrow(/attestation_hash mismatch/);
    });

    it('no attestation bound in the seal -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        await expect(run(fix, { seal: {} })).rejects.toThrow(/no attestation hash bound into the seal/);
    });

    it('directory page MISSING (directory shard object gone) -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        fix.mock.store.delete(fix.dirShardKey);
        await expect(run(fix)).rejects.toThrow(/\[ACTIVATE\] graph hop "posting_directory" object missing/);
    });

    it('directory -> posting page MISSING -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        fix.mock.store.delete(fix.projShardKey);
        await expect(run(fix)).rejects.toThrow(/\[ACTIVATE\] graph hop "posting_page" object missing/);
    });

    it('posting page -> canonical record MISSING -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        fix.mock.store.delete(fix.canonShardKey);
        await expect(run(fix)).rejects.toThrow(/\[ACTIVATE\] graph hop "canonical_record" object missing/);
    });

    it('directory_sha256 mismatch -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        const m = JSON.parse(fix.mock.store.get(fix.manifestKey).body);
        m.sample_posting.posting_list.directory_sha256 = 'd'.repeat(64);
        fix.mock.store.set(fix.manifestKey, { body: JSON.stringify(m) });
        await expect(run(fix)).rejects.toThrow(/directory_sha256 mismatch/);
    });

    it('page_sha256 mismatch -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        // Tamper the page ref inside the directory bytes is hard; instead tamper a
        // flat-list manifest by replacing the sample posting_list with the real page
        // ref but a bad page_sha256.
        const m = JSON.parse(fix.mock.store.get(fix.manifestKey).body);
        const realPage = { ...fix.proj.page_refs[0], page_sha256: 'e'.repeat(64) };
        m.sample_posting.posting_list = realPage;
        fix.mock.store.set(fix.manifestKey, { body: JSON.stringify(m) });
        await expect(run(fix)).rejects.toThrow(/page_sha256 mismatch/);
    });

    it('canonical content_hash mismatch -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        // Corrupt bytes INSIDE the sample record's entity payload (within its byte
        // range, past the 29-byte NXVF header). The slice still has a valid length so
        // the range gate passes; the zstd frame is now damaged -> NXVF decode fails OR
        // decodes to different content -> the canonical integrity gate fires.
        const orig = Buffer.from(fix.canon.shard_bytes);
        const loc0 = fix.canon.record_locators[0];
        for (let i = loc0.byte_offset; i < loc0.byte_offset + Math.min(8, loc0.byte_length); i++) orig[i] ^= 0xff;
        fix.mock.store.set(fix.canonShardKey, { body: orig });
        await expect(run(fix)).rejects.toThrow(/(content_hash mismatch|NXVF decode failed|range out of bounds|not JSON)/);
    });

    it('NXVF decode failure (canonical shard is not zstd) -> THROWS [ACTIVATE]', async () => {
        const fix = await buildGraphFamilyFixture();
        // Replace with bytes long enough to satisfy the range but undecodable as zstd.
        const big = Buffer.alloc(fix.mock.store.get(fix.canonShardKey).body.length, 0x7a);
        fix.mock.store.set(fix.canonShardKey, { body: big });
        await expect(run(fix)).rejects.toThrow(/(NXVF decode failed|range out of bounds)/);
    });

    it('canonical_id mismatch (record.id != locator.canonical_id, hash still valid) -> THROWS [ACTIVATE]', async () => {
        // Custom single-record family: keep the REAL content_hash (so the hash gate
        // passes) but set the locator.canonical_id to a DIFFERENT value, so the
        // record.id != locator.canonical_id guard fires independently of the hash.
        const prefix = 'snapshots/2026-06-15/701-1/';
        const records = makeCanonicalRecords(1);
        const canonShardKey = 'fg/canonical/shard-000.bin';
        const canon = await writeCanonicalShardAsync(records, { shardKey: canonShardKey });
        const realLoc = canon.record_locators[0];
        const o = records.find((r) => r.canonical_id === realLoc.canonical_id);
        const row = fixtureFamilyPolicy.project(o.record, realLoc);
        // Tamper BOTH the row + its embedded locator canonical_id (page_sha256 is
        // recomputed by the writer over the tampered row, so the page gate passes).
        const tamperedLoc = { ...realLoc, canonical_id: 'FX:9999' };
        const tamperedRow = { ...row, canonical_id: 'FX:9999', record_locator: tamperedLoc };
        const projShardKey = 'fg/projection/shard-000.bin';
        const proj = await writeProjectionPages([tamperedRow], { record_count_target: 1, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9 }, { shardKey: projShardKey });

        const mock = makeGraphMock();
        const manifestKey = `${prefix}fg/manifest.json`;
        mock.seed(manifestKey, JSON.stringify({
            family_id: FAMILY_ID, referential_integrity_attestation_hash: 'h'.repeat(64),
            sample_posting: { posting_list: proj.page_refs[0] },
        }));
        mock.seed(`${prefix}${canonShardKey}`, canon.shard_bytes);
        mock.seed(`${prefix}${projShardKey}`, proj.shard_bytes);

        const descriptor = {
            id: FAMILY_ID, kind: 'posting_graph',
            derive: (p) => `${p}fg/manifest.json`,
            resolveShardKey: (p, k) => `${p}${k}`,
            attestationField: 'referential_integrity_attestation_hash',
        };
        const seal = { posting_family_attestations: { [FAMILY_ID]: 'h'.repeat(64) } };
        await expect(probeActivationGraph({
            client: mock, bucket: 'b', objectPrefix: prefix, familyDescriptor: descriptor, seal,
        })).rejects.toThrow(/canonical_id mismatch/);
    });
});
