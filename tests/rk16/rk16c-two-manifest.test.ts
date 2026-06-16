// @ts-nocheck
/**
 * RK-16C D-103 A1 TWO-MANIFEST PREFLIGHT — pure-logic + adapter wiring tests.
 * ZERO network (FAKE client only); proves the auditable compatibility trust chain
 * and EVERY mandated fail-closed condition (D-102 + D-103 §10/§11).
 */
import { describe, it, expect } from 'vitest';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { canonicalManifestHash } from '../../scripts/factory/lib/snapshot-identity.js';
import {
    deriveObjectPrefix, deriveFileManifestKey, validateRootSeal, validateFileManifest,
    normalizeSatelliteInventory, reconcileFilesWithInventory, extractBioactivitiesEntry,
    TRUST_ANCHOR_MODE,
} from '../../scripts/spikes/rk16c/lib/two-manifest-preflight.mjs';
import { preflightManifest } from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    CANDIDATE_SNAPSHOT_ID, manifestObjectKey, fileManifestObjectKey,
    bioactivitiesObjectKey, objectPrefixOf,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';
import { validateLock } from '../../scripts/spikes/rk16c/lib/fullcorpus-lock.mjs';

const SNAP = CANDIDATE_SNAPSHOT_ID;
const PREFIX = objectPrefixOf(SNAP);
const SEAL_KEY = manifestObjectKey(SNAP);
const FILE_KEY = fileManifestObjectKey(SNAP);
const PAYLOAD_KEY = bioactivitiesObjectKey(SNAP);
const BIO = 'bioactivities.jsonl.gz';

// ---- producer-faithful fixture builders ----
function sealObj(over = {}) {
    const satellites = over.satellite_inventory || [PREFIX + BIO, PREFIX + 'papers.jsonl.gz'];
    const core = {
        layout_version: 'immutable_snapshot_v2',
        schema_version: 1,
        snapshot_id: over.snapshot_id !== undefined ? over.snapshot_id : SNAP,
        snapshot_date: '2026-06-14',
        object_prefix: over.object_prefix !== undefined ? over.object_prefix : PREFIX,
        run_id: '27502029137',
        run_attempt: '1',
        commit_sha: 'deadbeef',
        compound_total_records: 10,
        compound_shard_hashes: ['x'],
        required_inventory: [PREFIX + 'compounds/bucket-0000/manifest.json', ...satellites],
        satellite_inventory: satellites,
    };
    const seal = { ...core, manifest_hash: over.badHash ? 'a'.repeat(64) : canonicalManifestHash(core) };
    return seal;
}
function fileManifestObj(over = {}) {
    const files = over.files || [
        { filename: BIO, records: 475112, uncompressed_bytes: 200000000, compressed_bytes: 62914560, compression_ratio: 0.31, sha256_uncompressed: 'd'.repeat(64), sha256_compressed: 'b'.repeat(64) },
        { filename: 'papers.jsonl.gz', records: 36153, compressed_bytes: 48000000, sha256_compressed: 'c'.repeat(64) },
        { filename: 'xref-index.json.gz', records: 7, compressed_bytes: 1024, sha256_compressed: 'e'.repeat(64) }, // extra non-satellite
    ];
    return {
        snapshot_id: over.snapshot_id !== undefined ? over.snapshot_id : SNAP,
        object_prefix: over.object_prefix !== undefined ? over.object_prefix : PREFIX,
        schema_version: 1,
        run_id: '27502029137',
        files,
    };
}
const buf = (o) => Buffer.from(JSON.stringify(o));

// FAKE deps: route HEAD/GET by Key through the exact guard. Records every key.
function fakeDeps(bodies) {
    const seen = [];
    const client = {
        async send(command) {
            const ctor = command?.constructor?.name;
            const key = command?.input?.Key ?? null;
            seen.push({ ctor, key });
            const body = bodies[key];
            if (body === undefined) throw new Error(`fake: no body for ${key}`);
            if (ctor === 'HeadObjectCommand') return { ETag: `"${key}"`, ContentLength: body.length };
            return { ETag: `"${key}"`, Body: body };
        },
    };
    const headObject = async (c, b, k) => { const r = await c.send(new HeadObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.ContentLength }; };
    const getObject = async (c, b, k) => { const r = await c.send(new GetObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.Body.length, body: r.Body }; };
    return { seen, deps: { makeClient: () => client, instrument: instrumentExactReadOnlyClient, headObject, getObject, bucket: 'b' } };
}
function goodBodies(sealOver, fmOver) {
    return { [SEAL_KEY]: buf(sealObj(sealOver)), [FILE_KEY]: buf(fileManifestObj(fmOver)) };
}

describe('D-103 §5 — deterministic sibling-key derivation', () => {
    it('derives <object_prefix>manifest.json (test 1)', () => {
        expect(deriveObjectPrefix(SNAP)).toBe(PREFIX);
        expect(deriveFileManifestKey(PREFIX)).toBe(FILE_KEY);
        expect(FILE_KEY).toBe(`${PREFIX}manifest.json`);
    });
    it('rejects a non-/-terminated prefix', () => {
        expect(() => deriveFileManifestKey('snapshots/x')).toThrow(/object_prefix must end/);
    });
});

describe('D-103 §4 — Stage 1 root-seal validation', () => {
    it('valid seal -> facts; payload exactly once in satellite_inventory (test 4)', () => {
        const f = validateRootSeal(buf(sealObj()), { snapshotId: SNAP, payloadKey: PAYLOAD_KEY });
        expect(f.object_prefix).toBe(PREFIX);
        expect(f.production_run_id).toBe('27502029137-1');
        expect(f.stored_hash).toBe(f.recomputed_hash);
    });
    it('FAIL CLOSED on manifest_hash mismatch', () => {
        expect(() => validateRootSeal(buf(sealObj({ badHash: true })), { snapshotId: SNAP, payloadKey: PAYLOAD_KEY }))
            .toThrow(/manifest_hash mismatch/);
    });
    it('FAIL CLOSED on snapshot_id mismatch (never auto-switch)', () => {
        expect(() => validateRootSeal(buf(sealObj({ snapshot_id: 'other/9-1' })), { snapshotId: SNAP, payloadKey: PAYLOAD_KEY }))
            .toThrow(/snapshot_id mismatch/);
    });
    it('FAIL CLOSED when payload absent from satellite_inventory', () => {
        expect(() => validateRootSeal(buf(sealObj({ satellite_inventory: [PREFIX + 'papers.jsonl.gz'] })), { snapshotId: SNAP, payloadKey: PAYLOAD_KEY }))
            .toThrow(/absent from satellite_inventory/);
    });
    it('FAIL CLOSED when payload duplicated in satellite_inventory', () => {
        expect(() => validateRootSeal(buf(sealObj({ satellite_inventory: [PREFIX + BIO, PREFIX + BIO] })), { snapshotId: SNAP, payloadKey: PAYLOAD_KEY }))
            .toThrow(/duplicated/);
    });
    it('root seal need NOT list manifest.json (test 3)', () => {
        const seal = sealObj();
        expect(seal.required_inventory).not.toContain(FILE_KEY);
        expect(seal.satellite_inventory).not.toContain(FILE_KEY);
        expect(() => validateRootSeal(buf(seal), { snapshotId: SNAP, payloadKey: PAYLOAD_KEY })).not.toThrow();
    });
});

describe('D-103 §7 — reconciliation (set + target level)', () => {
    it('normalizes satellite keys -> bare filenames; rejects prefix escape', () => {
        const norm = normalizeSatelliteInventory([PREFIX + BIO, PREFIX + 'papers.jsonl.gz'], PREFIX);
        expect(norm).toEqual([BIO, 'papers.jsonl.gz']);
        expect(() => normalizeSatelliteInventory(['snapshots/OTHER/1-1/x.gz'], PREFIX)).toThrow(/escapes validated object_prefix/);
    });
    it('FAIL CLOSED on normalized satellite filename collision', () => {
        expect(() => normalizeSatelliteInventory([PREFIX + BIO, PREFIX + BIO], PREFIX)).toThrow(/collision/);
    });
    it('files[] satellite projection reconciles; extra non-satellite entries allowed (test 6,7)', () => {
        const { files } = validateFileManifest(buf(fileManifestObj()), { snapshotId: SNAP, objectPrefix: PREFIX });
        const proj = reconcileFilesWithInventory(files, [BIO, 'papers.jsonl.gz']);
        expect(proj.size).toBe(2); // xref-index extra entry NOT a false failure
        expect(extractBioactivitiesEntry(proj, BIO).sha256_compressed).toBe('b'.repeat(64));
    });
    it('FAIL CLOSED when a root-declared satellite is missing from files[] (test 8)', () => {
        const { files } = validateFileManifest(buf(fileManifestObj({ files: [{ filename: BIO, records: 1, compressed_bytes: 9, sha256_compressed: 'b'.repeat(64) }] })), { snapshotId: SNAP, objectPrefix: PREFIX });
        expect(() => reconcileFilesWithInventory(files, [BIO, 'papers.jsonl.gz'])).toThrow(/no entry in manifest.files|unreconcilable/);
    });
    it('FAIL CLOSED on duplicate files[] filename (test 9)', () => {
        const dup = fileManifestObj({ files: [
            { filename: BIO, records: 1, compressed_bytes: 9, sha256_compressed: 'b'.repeat(64) },
            { filename: BIO, records: 1, compressed_bytes: 9, sha256_compressed: 'b'.repeat(64) },
        ] });
        expect(() => validateFileManifest(buf(dup), { snapshotId: SNAP, objectPrefix: PREFIX })).toThrow(/duplicate files\[\] filename/);
    });
    it('FAIL CLOSED on missing target pins', () => {
        const { files } = validateFileManifest(buf(fileManifestObj({ files: [
            { filename: BIO, records: 1, compressed_bytes: 9 }, // no sha256_compressed
            { filename: 'papers.jsonl.gz', compressed_bytes: 1, sha256_compressed: 'c'.repeat(64) },
        ] })), { snapshotId: SNAP, objectPrefix: PREFIX });
        const proj = reconcileFilesWithInventory(files, [BIO, 'papers.jsonl.gz']);
        expect(() => extractBioactivitiesEntry(proj, BIO)).toThrow(/sha256_compressed invalid/);
    });
    it('FAIL CLOSED on files[] entry filename escaping the prefix', () => {
        expect(() => validateFileManifest(buf(fileManifestObj({ files: [{ filename: '../evil.gz', compressed_bytes: 1, sha256_compressed: 'b'.repeat(64) }] })), { snapshotId: SNAP, objectPrefix: PREFIX }))
            .toThrow(/escapes validated object_prefix|not a bare name/);
    });
    it('FAIL CLOSED on per-file manifest snapshot_id mismatch', () => {
        expect(() => validateFileManifest(buf(fileManifestObj({ snapshot_id: 'other/9-1' })), { snapshotId: SNAP, objectPrefix: PREFIX }))
            .toThrow(/snapshot_id mismatch/);
    });
});

describe('D-103 — adapter preflightManifest wires the two-manifest flow', () => {
    it('reads EXACTLY seal then manifest.json (no payload, no List, no 3rd key) (tests 10,11)', async () => {
        const { seen, deps } = fakeDeps(goodBodies());
        const r = await preflightManifest({ execute: true, snapshot: SNAP, manifestKey: SEAL_KEY, expectedRows: 475112 }, deps);
        expect(seen).toEqual([
            { ctor: 'HeadObjectCommand', key: SEAL_KEY },
            { ctor: 'GetObjectCommand', key: SEAL_KEY },
            { ctor: 'HeadObjectCommand', key: FILE_KEY },
            { ctor: 'GetObjectCommand', key: FILE_KEY },
        ]);
        expect(seen.some((s) => s.key === PAYLOAD_KEY)).toBe(false);
        expect(seen.some((s) => s.ctor.startsWith('List'))).toBe(false);
        expect(r.candidate.payload_sha256_compressed).toBe('b'.repeat(64));
        expect(r.candidate.payload_compressed_bytes).toBe(62914560);
        expect(r.candidate.expected_row_count).toBe(475112);
    });
    it('candidate records the A1 trust model (tests 12,13,14)', async () => {
        const { deps } = fakeDeps(goodBodies());
        const r = await preflightManifest({ execute: true, snapshot: SNAP, manifestKey: SEAL_KEY }, deps);
        expect(r.candidate.trust_anchor_mode).toBe(TRUST_ANCHOR_MODE);
        expect(r.candidate.root_directly_references_file_manifest).toBe(false);
        // never claims direct cryptographic root linkage
        const json = JSON.stringify(r.candidate).toLowerCase();
        expect(json).not.toContain('cryptograph');
        expect(json).not.toContain('root-sealed');
        // structurally complete v2 lock (sans ratification flags)
        const v = validateLock(r.candidate);
        expect(v.ok).toBe(true);
    });
    it('caller CANNOT override the manifest key with another object (test 2)', async () => {
        const { deps } = fakeDeps(goodBodies());
        await expect(preflightManifest({ execute: true, snapshot: SNAP, manifestKey: 'snapshots/latest.json' }, deps))
            .rejects.toThrow(/manifest-key mismatch/);
    });
    it('FAIL CLOSED when the seal object_prefix does not derive the expected sibling key (before 2nd read)', async () => {
        // Seal whose object_prefix is internally consistent but differs from pin -> validateRootSeal throws first.
        const { seen, deps } = fakeDeps(goodBodies({ object_prefix: 'snapshots/2026-06-14/OTHER-1/' }));
        await expect(preflightManifest({ execute: true, snapshot: SNAP, manifestKey: SEAL_KEY }, deps))
            .rejects.toThrow(/object_prefix mismatch/);
        // only the seal was read; manifest.json never reached.
        expect(seen.every((s) => s.key === SEAL_KEY)).toBe(true);
    });
    it('payload HEAD/GET is impossible — payload key is never allowlisted (test 11)', async () => {
        const { deps } = fakeDeps(goodBodies());
        // Even a body present for payload would never be requested; assert allowlist excludes it.
        const r = await preflightManifest({ execute: true, snapshot: SNAP, manifestKey: SEAL_KEY }, deps);
        expect(r.payload_key).toBe(PAYLOAD_KEY);
        expect(r.candidate.authorized_for_payload_read).toBeUndefined(); // stamped only by runPreflight
    });
});
