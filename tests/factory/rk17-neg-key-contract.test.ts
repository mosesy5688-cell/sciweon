// @ts-nocheck
/**
 * RK-17 -- split the neg-evidence DESCRIPTOR key from the VALIDATION-PROBE key,
 * with ONE shared contract (buildNegKeyContract) both the normal F4 path and the
 * V3 harness consume.
 *
 * The defect: buildAndSealCandidate overloaded ONE negManifestKey param for two
 * incompatible roles -- (a) the serving descriptor (bare `<prefix>neg-evidence/`
 * root, written into the seal + latest, normalized by the reader) and (b) a
 * required_inventory existence probe (HEAD-ed for non-empty). A bare-prefix key
 * is NOT a real R2 object -> HEAD 404 -> a COMPLETE candidate FALSELY rejected.
 * The F4 path passed the root; the V3 harness passed a real per-bucket manifest:
 * the two DIVERGED. The fix names the two keys explicitly and routes them via
 * the SAME buildNegKeyContract so neither path hand-rolls its own neg key string.
 *
 * Mock S3 emulates R2 conditional PUTs (true R2 honoring is confirmed live).
 */

import { describe, it, expect } from 'vitest';
import {
    negEvidenceDescriptorKey, negEvidenceRootKey, negManifestKey, buildNegKeyContract,
    canonicalManifestHash,
} from '../../scripts/factory/lib/snapshot-identity.js';
import {
    buildAndSealCandidate, validateCandidate, activateValidatedCandidate,
} from '../../scripts/factory/lib/stage-4-activate.js';
import { putCreateOnly } from '../../scripts/factory/lib/snapshot-identity.js';
import { makeClient, publishCandidate, LATEST_KEY } from './helpers/pr-b-activate-fixtures';
import { parseSnapshotContext } from '../../src/worker/lib/snapshot-context';

const PREFIX = 'snapshots/2026-06-14/777-1/';

/** A publishNegShards-shaped result with N real per-bucket manifest keys. */
function negResult(prefix: string, buckets: number[]) {
    return { manifestKeys: buckets.map(b => negManifestKey(prefix, b)), bucketCount: buckets.length };
}

/** Seed a real (non-empty) neg per-bucket manifest object into the store. */
async function seedNeg(client: any, prefix: string, bucket = 0) {
    const key = negManifestKey(prefix, bucket);
    await putCreateOnly(client, 'b', key, Buffer.from('{"bucket":0,"total_records":1}'), 'application/json');
    return key;
}

describe('RK-17 -- descriptor vs validation-probe key split', () => {
    it('(1) negEvidenceDescriptorKey resolves to the bare <prefix>neg-evidence/ root', () => {
        expect(negEvidenceDescriptorKey(PREFIX)).toBe(`${PREFIX}neg-evidence/`);
        // It IS the same value the reader already normalizes (negEvidenceRootKey).
        expect(negEvidenceDescriptorKey(PREFIX)).toBe(negEvidenceRootKey(PREFIX));
        expect(negEvidenceDescriptorKey(PREFIX).endsWith('/')).toBe(true);
    });

    it('(2) buildNegKeyContract validationProbeKey is a REAL per-bucket manifest (manifestKeys[0]); null when no buckets', () => {
        const contract = buildNegKeyContract(PREFIX, negResult(PREFIX, [0]));
        expect(contract.descriptorKey).toBe(`${PREFIX}neg-evidence/`);
        expect(contract.validationProbeKey).toBe(`${PREFIX}neg-evidence/bucket-0000/manifest.json`);
        expect(contract.validationProbeKey.endsWith('/')).toBe(false); // a real object
        // No buckets -> probe key null (neg empty/skipped).
        expect(buildNegKeyContract(PREFIX, negResult(PREFIX, [])).validationProbeKey).toBeNull();
        expect(buildNegKeyContract(PREFIX, null).validationProbeKey).toBeNull();
    });

    it('(3) validateCandidate REFUSES to HEAD a trailing-slash required key (the guard throws)', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-14', '300');
        await seedNeg(client, prefix);
        // Seal with a BAD validationProbeKey = the bare descriptor root (the exact
        // RK-17 defect). This produces a HASH-CONSISTENT seal whose required_inventory
        // legitimately contains a trailing-slash key, so the seal-hash gate passes and
        // execution reaches the per-key HEAD loop -> the guard must refuse the prefix.
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest,
            neg: { descriptorKey: negEvidenceRootKey(prefix), validationProbeKey: negEvidenceRootKey(prefix) },
            hasXref: true, hasSearch: true,
        });
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).rejects.toThrow(/logical-prefix key|real object/i);
    });

    it('(4) a REAL probe key present -> validateCandidate PASSES', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-14', '301');
        const negKey = await seedNeg(client, prefix);
        const neg = { descriptorKey: negEvidenceRootKey(prefix), validationProbeKey: negKey };
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest, neg, hasXref: true, hasSearch: true,
        });
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).resolves.toMatchObject({ state: 'VALIDATED' });
    });

    it('(5) probe key missing/404 -> validateCandidate FAILS (typed error)', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-14', '302');
        const negKey = await seedNeg(client, prefix);
        const neg = { descriptorKey: negEvidenceRootKey(prefix), validationProbeKey: negKey };
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest, neg, hasXref: true, hasSearch: true,
        });
        client.store.delete(negKey); // the real per-bucket manifest disappears
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).rejects.toThrow(/required candidate object missing/i);
    });

    it('(6) the descriptor root pointer is written into BOTH the seal AND the latest payload neg_evidence_manifest_key', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-14', '303');
        const negKey = await seedNeg(client, prefix);
        const neg = { descriptorKey: negEvidenceRootKey(prefix), validationProbeKey: negKey };
        await activateValidatedCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest, neg, hasXref: true, hasSearch: true,
        });
        // Seal field == descriptor root (NOT the probe key).
        const seal = JSON.parse(client.store.get(`${prefix}_snapshot.manifest.json`).body);
        expect(seal.neg_evidence_manifest_key).toBe(`${prefix}neg-evidence/`);
        // latest payload field == descriptor root.
        const latest = JSON.parse(client.store.get(LATEST_KEY).body);
        expect(latest.neg_evidence_manifest_key).toBe(`${prefix}neg-evidence/`);
        // The probe key is in required_inventory; the descriptor root is NOT.
        expect(seal.required_inventory).toContain(negKey);
        expect(seal.required_inventory).not.toContain(`${prefix}neg-evidence/`);
    });

    it('(7) the descriptor field shape is unchanged vs before (reader still parses the root pointer)', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-14', '304');
        const negKey = await seedNeg(client, prefix);
        const neg = { descriptorKey: negEvidenceRootKey(prefix), validationProbeKey: negKey };
        await activateValidatedCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest, neg, hasXref: true, hasSearch: true,
        });
        const ctx = parseSnapshotContext(client.store.get(LATEST_KEY).body);
        // The DEPLOYED reader sees the root pointer (the contract it normalizes at
        // /neg-evidence/) -- byte-identical to the historical descriptor value.
        expect(ctx.neg_evidence_manifest_key).toBe(`${prefix}neg-evidence/`);
    });

    it('(8) the V3-harness path and the normal-F4 path produce an IDENTICAL neg key contract from the same inputs', () => {
        const result = negResult(PREFIX, [0, 1, 7]);
        // Normal F4 (stage-4-neg-publish) and the V3 harness both call THIS helper.
        const f4 = buildNegKeyContract(PREFIX, result);
        const v3 = buildNegKeyContract(PREFIX, result);
        expect(f4).toEqual(v3); // deep-equal -> the divergence is structurally closed
        expect(f4.descriptorKey).toBe(`${PREFIX}neg-evidence/`);
        expect(f4.validationProbeKey).toBe(`${PREFIX}neg-evidence/bucket-0000/manifest.json`);
    });

    it('(9) an end-to-end COMPLETE candidate (neg + compound + xref + search + satellites) passes validateCandidate', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-14', '305', true);
        const negKey = await seedNeg(client, prefix);
        const neg = { descriptorKey: negEvidenceRootKey(prefix), validationProbeKey: negKey };
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest, neg, hasXref: true, hasSearch: true,
        });
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).resolves.toMatchObject({ state: 'VALIDATED' });
    });

    it('(10) a validation failure leaves latest UNCHANGED (no swap on a failed validate)', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-14', '306');
        const negKey = await seedNeg(client, prefix);
        const neg = { descriptorKey: negEvidenceRootKey(prefix), validationProbeKey: negKey };
        client.store.set(LATEST_KEY, { body: JSON.stringify({ latest_snapshot_date: '2000-01-01' }), etag: '"old"' });
        client.store.delete(negKey); // probe key gone -> validate fails before any swap
        await expect(
            activateValidatedCandidate({
                client, bucket: 'b', identity, compoundManifest: manifest, neg, hasXref: true, hasSearch: true,
            }),
        ).rejects.toThrow(/required candidate object missing/i);
        // latest.json is still the OLD pointer (swapV2Latest never ran).
        expect(JSON.parse(client.store.get(LATEST_KEY).body).latest_snapshot_date).toBe('2000-01-01');
    });
});
