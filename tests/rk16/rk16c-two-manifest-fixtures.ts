// @ts-nocheck
/**
 * PRODUCER-FAITHFUL fixtures + fake deps for the RK-16C two-manifest preflight
 * (D-120 A1). DEFAULTS mirror the real F4 seal: satellite_inventory=[] and
 * required_inventory=structured keys only (the payload is in NEITHER seal field).
 * The payload IS a producer required-satellite (SSoT) by construction and appears
 * exactly once in the sibling manifest.files[] with valid pins.
 */
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { canonicalManifestHash } from '../../scripts/factory/lib/snapshot-identity.js';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
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

/** PRODUCTION-FAITHFUL seal: payload in NEITHER seal field. satellite_inventory=[];
 *  required_inventory=structured keys only. Overridable for negatives. */
export function sealObj(over: any = {}) {
    const core: any = {
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
        required_inventory: over.required_inventory !== undefined ? over.required_inventory
            : [PREFIX + 'compounds/bucket-0000/manifest.json', PREFIX + 'xref-index.json.gz'],
        satellite_inventory: over.satellite_inventory !== undefined ? over.satellite_inventory : [],
    };
    return { ...core, manifest_hash: over.badHash ? 'a'.repeat(64) : canonicalManifestHash(core) };
}

/** Sibling per-file manifest: payload present exactly once + valid pins; an extra
 *  non-payload entry (xref-index) is allowed. Overridable for negatives. */
export function fileManifestObj(over: any = {}) {
    const files = over.files || [
        { filename: BIO, records: 475112, uncompressed_bytes: 200000000, compressed_bytes: 62914560, compression_ratio: 0.31, sha256_uncompressed: 'd'.repeat(64), sha256_compressed: 'b'.repeat(64) },
        { filename: 'papers.jsonl.gz', records: 36153, compressed_bytes: 48000000, sha256_compressed: 'c'.repeat(64) },
        { filename: 'xref-index.json.gz', records: 7, compressed_bytes: 1024, sha256_compressed: 'e'.repeat(64) },
    ];
    return {
        snapshot_id: over.snapshot_id !== undefined ? over.snapshot_id : SNAP,
        object_prefix: over.object_prefix !== undefined ? over.object_prefix : PREFIX,
        schema_version: 1,
        run_id: '27502029137',
        files,
    };
}

export const buf = (o: any) => Buffer.from(JSON.stringify(o));

export function goodBodies(sealOver?: any, fmOver?: any) {
    return { [SEAL_KEY]: buf(sealObj(sealOver)), [FILE_KEY]: buf(fileManifestObj(fmOver)) };
}

/** FAKE deps: route HEAD/GET by Key through the exact read-only guard; records
 *  every requested key + command ctor so tests can assert the exact read path. */
export function fakeDeps(bodies: any) {
    const seen: any[] = [];
    const client = {
        async send(command: any) {
            const ctor = command?.constructor?.name;
            const key = command?.input?.Key ?? null;
            seen.push({ ctor, key });
            const body = bodies[key];
            if (body === undefined) throw new Error(`fake: no body for ${key}`);
            if (ctor === 'HeadObjectCommand') return { ETag: `"${key}"`, ContentLength: body.length };
            return { ETag: `"${key}"`, Body: body };
        },
    };
    const headObject = async (c: any, b: any, k: any) => { const r = await c.send(new HeadObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.ContentLength }; };
    const getObject = async (c: any, b: any, k: any) => { const r = await c.send(new GetObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.Body.length, body: r.Body }; };
    return { seen, deps: { makeClient: () => client, instrument: instrumentExactReadOnlyClient, headObject, getObject, bucket: 'b' } };
}
