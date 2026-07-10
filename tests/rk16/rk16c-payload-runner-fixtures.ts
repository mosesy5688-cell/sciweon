// @ts-nocheck
/**
 * FIXTURES for the RK-16C D-129 ratified-lock-gated payload runner tests. ALL fake
 * clients, ZERO network. Provides: a valid root seal + sibling manifest (with real
 * sha256s), a small gzip payload fixture (real compressed/uncompressed sha256 + row
 * count), lock builders (production-pinned + fixture-pinned), a temp-lock writer
 * that returns the file sha256, and a fake HEAD/GET dep set routed through the exact
 * read-only guard. NEVER makeR2Client, NEVER production R2.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { canonicalManifestHash } from '../../scripts/factory/lib/snapshot-identity.js';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import { RATIFIED_PINS } from '../../scripts/spikes/rk16c/lib/fullcorpus-run-gate.mjs';
import {
    CANDIDATE_SNAPSHOT_ID, manifestObjectKey, fileManifestObjectKey,
    bioactivitiesObjectKey, objectPrefixOf,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';

export const SNAP = CANDIDATE_SNAPSHOT_ID;
export const PREFIX = objectPrefixOf(SNAP);
export const SEAL_KEY = manifestObjectKey(SNAP);
export const FILE_KEY = fileManifestObjectKey(SNAP);
export const PAYLOAD_KEY = bioactivitiesObjectKey(SNAP);
export const BIO = 'bioactivities.jsonl.gz';
export const sha256 = (b: any) => createHash('sha256').update(b).digest('hex');

/** A valid production-faithful root seal (recomputed manifest_hash). */
export function sealBody(): Buffer {
    const core: any = {
        layout_version: 'immutable_snapshot_v2', schema_version: 1, snapshot_id: SNAP,
        snapshot_date: '2026-06-14', object_prefix: PREFIX, run_id: '27502029137', run_attempt: '1',
        compound_total_records: 10, compound_shard_hashes: ['x'],
        required_inventory: [PREFIX + 'compounds/bucket-0000/manifest.json'], satellite_inventory: [],
    };
    return Buffer.from(JSON.stringify({ ...core, manifest_hash: canonicalManifestHash(core) }));
}
/** A valid sibling per-file manifest (bio present once with valid pins). */
export function fileBody(): Buffer {
    const files = [
        { filename: BIO, records: 475112, compressed_bytes: 62914560, sha256_compressed: 'b'.repeat(64) },
        { filename: 'papers.jsonl.gz', records: 7, compressed_bytes: 9, sha256_compressed: 'c'.repeat(64) },
    ];
    return Buffer.from(JSON.stringify({ snapshot_id: SNAP, object_prefix: PREFIX, schema_version: 1, run_id: '27502029137', files }));
}
export const SEAL_SHA = sha256(sealBody());
export const FILE_SHA = sha256(fileBody());

/** A small real gzip payload fixture: N newline-terminated jsonl rows. */
export function gzFixture(n = 6) {
    const content = Array.from({ length: n }, (_, k) => `{"i":${k}}`).join('\n') + '\n';
    const uncompressed = Buffer.from(content, 'utf-8');
    const compressed = zlib.gzipSync(uncompressed);
    return { compressed, rows: n, comp_sha: sha256(compressed), uncomp_sha: sha256(uncompressed), uncompressed_bytes: uncompressed.length };
}
export const GZ = gzFixture();
/** Injected pins matching the gz fixture (so the gate passes for network tests). */
export const FIXTURE_PINS = Object.freeze({
    ...RATIFIED_PINS,
    payload_sha256_compressed: GZ.comp_sha,
    payload_sha256_uncompressed: GZ.uncomp_sha,
    expected_row_count: GZ.rows,
});

function baseLock(over: any = {}) {
    return {
        candidate_lock_schema: RATIFIED_PINS.candidate_lock_schema,
        trust_anchor_mode: RATIFIED_PINS.trust_anchor_mode,
        root_directly_references_file_manifest: false,
        file_manifest_key_derivation: 'validated_object_prefix + "manifest.json"',
        payload_membership_anchor: 'producer required-satellite SSoT',
        payload_membership_authority: RATIFIED_PINS.payload_membership_authority,
        payload_pin_authority: RATIFIED_PINS.payload_pin_authority,
        file_manifest_admissibility_anchor: 'deterministic sibling key + create-only producer co-publication',
        root_manifest_key: SEAL_KEY, root_manifest_etag: '"m"', root_manifest_byte_size: 1024,
        root_manifest_sha256: SEAL_SHA, root_manifest_stored_hash: 'a'.repeat(64), root_manifest_recomputed_hash: 'a'.repeat(64),
        file_manifest_key: FILE_KEY, file_manifest_etag: '"f"', file_manifest_byte_size: 512,
        file_manifest_sha256: FILE_SHA, file_manifest_schema_version: 1,
        payload_key: RATIFIED_PINS.payload_key, payload_filename: BIO,
        payload_sha256_compressed: RATIFIED_PINS.payload_sha256_compressed,
        payload_sha256_uncompressed: RATIFIED_PINS.payload_sha256_uncompressed,
        payload_compressed_bytes: 62914560, expected_row_count: RATIFIED_PINS.expected_row_count,
        snapshot_id: RATIFIED_PINS.snapshot_id, production_run_id: '27502029137-1',
        producer_contract_version: 'snapshot-schema-v1',
        ...over,
    };
}
/** A lock carrying the EXACT ratified production pins (for fail-before-network). */
export function ratifiedLock(over: any = {}) { return baseLock(over); }
/** A lock carrying the gz-fixture pins (for network/decode tests + FIXTURE_PINS). */
export function fixtureLock(over: any = {}) {
    return baseLock({
        payload_sha256_compressed: GZ.comp_sha,
        payload_sha256_uncompressed: GZ.uncomp_sha,
        payload_compressed_bytes: GZ.compressed.length,
        expected_row_count: GZ.rows,
        ...over,
    });
}

/** Write a lock to a temp file; return its path + the file-bytes sha256. */
export function writeLock(lock: any) {
    const p = path.join(os.tmpdir(), `rk16c-d129-lock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(lock, null, 2));
    return { path: p, sha: sha256(fs.readFileSync(p)) };
}

/** Fake deps: HEAD/GET routed through the exact read-only guard; records `seen`. */
export function fakeDeps(bodies: any) {
    const seen: any[] = [];
    const client = {
        async send(command: any) {
            const ctor = command?.constructor?.name; const key = command?.input?.Key ?? null;
            seen.push({ ctor, key });
            const body = bodies[key];
            if (body === undefined) throw new Error(`fake: no body for ${key}`);
            if (ctor === 'HeadObjectCommand') return { ETag: '"e"', ContentLength: body.length };
            return { ETag: '"e"', Body: body };
        },
    };
    const headObject = async (c: any, b: any, k: any) => { const r = await c.send(new HeadObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.ContentLength }; };
    const getObject = async (c: any, b: any, k: any) => { const r = await c.send(new GetObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.Body.length, body: r.Body }; };
    return { seen, deps: { makeClient: () => client, instrument: instrumentExactReadOnlyClient, headObject, getObject, bucket: 'fake-bucket' } };
}

/** Deps whose makeClient/HEAD/GET all throw (to prove no client is constructed). */
export function throwingDeps() {
    let clientMade = false;
    const deps = {
        makeClient: () => { clientMade = true; throw new Error('makeClient MUST NOT be called'); },
        instrument: instrumentExactReadOnlyClient,
        headObject: async () => { throw new Error('HEAD MUST NOT be reached'); },
        getObject: async () => { throw new Error('GET MUST NOT be reached'); },
        bucket: 'x',
    };
    return { deps, wasClientMade: () => clientMade };
}
export const goodPayloadBodies = () => ({ [SEAL_KEY]: sealBody(), [FILE_KEY]: fileBody(), [PAYLOAD_KEY]: GZ.compressed });
