// @ts-nocheck
/**
 * RK-16A2 — exhaustive referential-integrity attestation: clean default;
 * dangling locator -> dangling>0 + assert throws; content_hash mismatch -> >0.
 */
import { describe, it, expect } from 'vitest';
import {
    attestReferentialIntegrity, assertCleanReferentialIntegrity,
} from '../../../scripts/factory/lib/rk16/referential-integrity.js';
import { writeCanonicalShardAsync } from '../../../scripts/factory/lib/rk16/canonical-shard-writer.js';
import { makeCanonicalRecords, fixtureFamilyPolicy } from './_fixture-family.js';

async function setup(n) {
    const records = makeCanonicalRecords(n);
    const canon = await writeCanonicalShardAsync(records, { shardKey: 'canon/shard-000.bin' });
    const byId = new Map(canon.record_locators.map((l) => [l.canonical_id, l]));
    const rows = canon.record_locators.map((loc) => {
        const orig = records.find((r) => r.canonical_id === loc.canonical_id);
        return fixtureFamilyPolicy.project(orig.record, loc);
    });
    // resolver: look up the canonical locator by canonical_id
    const resolve = (locator) => byId.get(locator.canonical_id);
    return { rows, resolve, byId };
}

describe('referential-integrity', () => {
    it('clean fixture -> dangling=0, mismatch=0, stable attestation_hash', async () => {
        const { rows, resolve } = await setup(6);
        const a1 = attestReferentialIntegrity(rows, resolve);
        expect(a1.projection_record_count).toBe(6);
        expect(a1.canonical_resolved_count).toBe(6);
        expect(a1.dangling_reference_count).toBe(0);
        expect(a1.content_hash_mismatch_count).toBe(0);
        expect(a1.referential_integrity_attestation_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(() => assertCleanReferentialIntegrity(a1)).not.toThrow();

        // deterministic / stable
        const a2 = attestReferentialIntegrity(rows, resolve);
        expect(a2.referential_integrity_attestation_hash).toBe(a1.referential_integrity_attestation_hash);
    });

    it('injected dangling locator -> dangling_reference_count>0 and assert throws', async () => {
        const { rows, resolve } = await setup(4);
        rows[1] = { ...rows[1], record_locator: { ...rows[1].record_locator, canonical_id: 'NO_SUCH_ID' } };
        const a = attestReferentialIntegrity(rows, resolve);
        expect(a.dangling_reference_count).toBeGreaterThan(0);
        expect(() => assertCleanReferentialIntegrity(a)).toThrow(/not clean/i);
    });

    it('injected content_hash mismatch -> content_hash_mismatch_count>0 and assert throws', async () => {
        const { rows, resolve } = await setup(4);
        rows[2] = { ...rows[2], canonical_content_hash: 'd'.repeat(64) };
        const a = attestReferentialIntegrity(rows, resolve);
        expect(a.content_hash_mismatch_count).toBeGreaterThan(0);
        expect(() => assertCleanReferentialIntegrity(a)).toThrow();
    });
});
