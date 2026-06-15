// @ts-nocheck
/**
 * RK-16A3 — THE backward-compat no-op test (the whole PR's safety hinge).
 *
 * Proves that for a CURRENT-SHAPE candidate (compounds + neg + xref + search, NO
 * posting/graph family):
 *   1. buildAndSealCandidate produces the SAME manifest_hash whether called WITH
 *      an empty postingFamilies (the new param, defaulted) or WITHOUT it at all
 *      -> the new field is NEVER added -> sealCore byte-identical -> hash unchanged;
 *   2. the seal carries NO posting_family_attestations field;
 *   3. the required-inventory set is UNCHANGED by the new param;
 *   4. enforceCompleteStructuredInventory is a NO-OP for the posting_graph kind
 *      (the default production STRUCTURED_INVENTORY registers no such family).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAndSealCandidate } from '../../../scripts/factory/lib/stage-4-activate.js';
import { enforceCompleteStructuredInventory } from '../../../scripts/factory/lib/candidate-structured-inventory.js';
import { STRUCTURED_INVENTORY } from '../../../scripts/factory/lib/snapshot-inventory.js';
import { negManifestKey, buildNegKeyContract } from '../../../scripts/factory/lib/snapshot-identity.js';

const BUCKET = 'b';
const PREFIX = 'snapshots/2026-06-15/800-1/';

function makeMock() {
    const store = new Map();
    return {
        store,
        async send(cmd) {
            const name = cmd.constructor.name;
            const { Key } = cmd.input;
            if (name === 'PutObjectCommand') {
                if (cmd.input.IfNoneMatch === '*' && store.has(Key)) {
                    const e = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
                }
                store.set(Key, { body: cmd.input.Body });
                return {};
            }
            throw new Error(`unexpected ${name}`);
        },
    };
}

const IDENTITY = {
    snapshotId: '2026-06-15/800-1', objectPrefix: PREFIX, snapshotDate: '2026-06-15',
    runId: '800', runAttempt: '1', commitSha: 'deadbeef',
};
const COMPOUND_MANIFEST = { bucket: 0, total_records: 3, shard_hashes: [{ shard: 0, filename: 'shard-000.bin', sha256: 'x', size_bytes: 29 }] };

async function seal(client, extra = {}) {
    return buildAndSealCandidate({
        client, bucket: BUCKET, identity: IDENTITY, compoundManifest: COMPOUND_MANIFEST,
        neg: buildNegKeyContract(PREFIX, { manifestKeys: [negManifestKey(PREFIX, 0)] }),
        hasXref: true, hasSearch: true, ...extra,
    });
}

describe('RK-16A3 — backward-compat no-op (current-shape candidate)', () => {
    // Freeze wall-clock so the seal's created_at is identical across builds; the
    // ONLY thing that could then differ between "param absent" and "param=[]" is the
    // RK-16A3 field — which must NOT be added for a current-shape candidate.
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z')); });
    afterEach(() => { vi.useRealTimers(); });

    it('manifest_hash is IDENTICAL with the new postingFamilies param absent vs empty []', async () => {
        const a = await seal(makeMock());                       // param absent
        const b = await seal(makeMock(), { postingFamilies: [] }); // param = []
        expect(b.manifestHash).toBe(a.manifestHash);
        // And the sealCore (sans manifest_hash) is byte-identical.
        const { manifest_hash: _a, ...ca } = a.seal;
        const { manifest_hash: _b, ...cb } = b.seal;
        expect(cb).toEqual(ca);
    });

    it('the seal carries NO posting_family_attestations field (current shape)', async () => {
        const { seal: s } = await seal(makeMock(), { postingFamilies: [] });
        expect('posting_family_attestations' in s).toBe(false);
    });

    it('the required-inventory set is UNCHANGED by the new param', async () => {
        const a = await seal(makeMock());
        const b = await seal(makeMock(), { postingFamilies: [] });
        expect(b.seal.required_inventory).toEqual(a.seal.required_inventory);
        expect(b.seal.satellite_inventory).toEqual(a.seal.satellite_inventory);
    });

    it('production STRUCTURED_INVENTORY registers NO posting_graph family', () => {
        const graphFamilies = STRUCTURED_INVENTORY.filter((e) => e.kind === 'posting_graph');
        expect(graphFamilies).toEqual([]);
    });

    it('enforceCompleteStructuredInventory is a NO-OP for the posting_graph kind (none registered)', async () => {
        // The default inventory has no posting_graph entry -> the new branch is never
        // hit -> a mock that throws on ANY GET still resolves (proves no graph probe).
        const inventory = STRUCTURED_INVENTORY.filter((e) => e.kind === 'posting_graph');
        const throwingClient = { async send() { throw new Error('should not be called'); } };
        await expect(
            enforceCompleteStructuredInventory({ client: throwingClient, bucket: BUCKET, objectPrefix: PREFIX, seal: {}, inventory }),
        ).resolves.toBeUndefined();
    });
});
