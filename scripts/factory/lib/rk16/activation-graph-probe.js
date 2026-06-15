/**
 * RK-16A3 — GENERIC activation GRAPH probe (Node-side, OFFLINE-decodable).
 *
 * Walks + verifies ONE SAMPLE chain of a posting/graph family against the live
 * candidate objects, mirroring how the A2 readers (canonical/projection/
 * directory-reader.ts) decode an NXVF entity:
 *
 *   family manifest
 *     -> PostingDirectoryRef  (GET dir shard, range-slice, zstd-decode, sha256)
 *     -> PostingPageRef       (GET page shard, range-slice, zstd-decode, sha256)
 *     -> projection page rows -> embedded RecordLocator
 *     -> canonical record     (GET canonical shard, range-slice, zstd-decode,
 *                              canonical content_hash, canonical_id match)
 *
 * EVERY hop verifies: object exists; range bounds in [0, shardLen]; the sha256
 * matches (directory_sha256 / page_sha256 / canonical content_hash); NXVF decode
 * succeeds (zstd via zstd-helper); canonical_id matches; canonical_content_hash
 * matches. ANY failed hop throws a typed loud [ACTIVATE] error.
 *
 * Build-time-exhaustive vs activation-sample split (per the contract): the A2
 * producer attests referential integrity over ALL rows at build time; activation
 * does NOT re-exhaust — it walks ONE sample chain AND verifies the family
 * manifest's referential_integrity_attestation_hash is present AND equals the
 * value bound into the seal.
 *
 * Substrate-only: no business policy; reads candidate objects, NEVER latest.json.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { zstdDecompress } from '../zstd-helper.js';
import { sha256Bytes, contentHash } from './content-hash.js';

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

async function getBuffer(client, bucket, key, hop) {
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return await streamToBuffer(res.Body);
    } catch (err) {
        throw new Error(`[ACTIVATE] graph hop "${hop}" object missing: ${key} (${err.message})`);
    }
}

/** Slice [offset, +length) from a shard, asserting the range is in-bounds. */
function rangeSlice(shardBuf, offset, length, hop, key) {
    if (!Number.isInteger(offset) || !Number.isInteger(length)
        || offset < 0 || length <= 0 || offset + length > shardBuf.length) {
        throw new Error(`[ACTIVATE] graph hop "${hop}" range out of bounds `
            + `(offset=${offset}, length=${length}, shard_len=${shardBuf.length}): ${key}`);
    }
    return shardBuf.subarray(offset, offset + length);
}

/** Decode ONE NXVF entity payload: range-slice -> zstd-decompress -> UTF-8 text.
 * Crypto is a no-op passthrough (shard-crypto Phase 1), mirroring the readers. */
async function decodeEntityText(shardBuf, offset, length, hop, key) {
    const slice = rangeSlice(shardBuf, offset, length, hop, key);
    let plain;
    try {
        plain = await zstdDecompress(slice);
    } catch (err) {
        throw new Error(`[ACTIVATE] graph hop "${hop}" NXVF decode failed: ${key} (${err.message})`);
    }
    return plain.toString('utf-8');
}

/**
 * Walk + verify ONE sample chain for a posting/graph family.
 *
 * @param {object} args
 * @param {object} args.client       S3/R2 client (GET only)
 * @param {string} args.bucket
 * @param {string} args.objectPrefix candidate object_prefix (ends in '/')
 * @param {object} args.familyDescriptor a 'posting_graph' STRUCTURED entry:
 *        { id, derive(objectPrefix)->manifestKey, resolveShardKey?(objectPrefix,shardKey),
 *          attestationField } (attestationField names the manifest's attestation hash).
 * @param {object} args.seal         the candidate seal (carries the bound attestation hash).
 */
export async function probeActivationGraph({ client, bucket, objectPrefix, familyDescriptor, seal }) {
    const id = familyDescriptor.id;
    const manifestKey = familyDescriptor.derive(objectPrefix);
    // (0) family manifest.
    let manifest;
    try {
        manifest = JSON.parse((await getBuffer(client, bucket, manifestKey, 'family_manifest')).toString('utf-8'));
    } catch (err) {
        throw new Error(`[ACTIVATE] graph family "${id}" manifest unreadable: ${manifestKey} (${err.message})`);
    }

    // (0b) attestation binding: the manifest MUST carry the attestation hash AND
    // it MUST equal the value bound into the seal (build-exhaustive vs activation-
    // sample split — activation verifies the hash, never re-exhausts all rows).
    const attestField = familyDescriptor.attestationField || 'referential_integrity_attestation_hash';
    const manifestAttest = manifest[attestField];
    if (!manifestAttest) {
        throw new Error(`[ACTIVATE] graph family "${id}" manifest missing ${attestField}: ${manifestKey}`);
    }
    const sealAttest = (seal && seal.posting_family_attestations && seal.posting_family_attestations[id]) || null;
    if (!sealAttest) {
        throw new Error(`[ACTIVATE] graph family "${id}" has no attestation hash bound into the seal`);
    }
    if (manifestAttest !== sealAttest) {
        throw new Error(`[ACTIVATE] graph family "${id}" attestation_hash mismatch: `
            + `manifest=${manifestAttest} seal=${sealAttest}`);
    }

    // The manifest names a SAMPLE posting list (one index key) to walk.
    const sample = manifest.sample_posting || (Array.isArray(manifest.posting_lists) ? manifest.posting_lists[0] : null);
    if (!sample || !sample.posting_list) {
        throw new Error(`[ACTIVATE] graph family "${id}" manifest declares no sample posting list: ${manifestKey}`);
    }
    const resolveShard = familyDescriptor.resolveShardKey
        || ((prefix, shardKey) => `${prefix}${shardKey}`);

    // (1) resolve the SAMPLE PostingPageRef — either inline (flat) or via a
    // PostingDirectoryRef (two-level).
    let pageRef;
    const pl = sample.posting_list;
    if (pl.kind === 'posting_directory_ref') {
        const dirKey = resolveShard(objectPrefix, pl.directory_shard_key);
        const dirBuf = await getBuffer(client, bucket, dirKey, 'posting_directory');
        const dirText = await decodeEntityText(dirBuf, pl.directory_offset, pl.directory_length, 'posting_directory', dirKey);
        if (sha256Bytes(Buffer.from(dirText, 'utf-8')) !== pl.directory_sha256) {
            throw new Error(`[ACTIVATE] graph family "${id}" directory_sha256 mismatch: ${dirKey}`);
        }
        const pageRefs = JSON.parse(dirText);
        pageRef = Array.isArray(pageRefs) ? pageRefs[0] : null;
        if (!pageRef) throw new Error(`[ACTIVATE] graph family "${id}" directory holds no page refs: ${dirKey}`);
    } else if (pl.kind === 'posting_page_ref') {
        pageRef = pl;
    } else if (Array.isArray(pl)) {
        pageRef = pl[0];
    } else {
        throw new Error(`[ACTIVATE] graph family "${id}" sample posting_list has unknown kind: ${pl.kind}`);
    }

    // (2) PostingPageRef -> projection page rows.
    const pageKey = resolveShard(objectPrefix, pageRef.shard_key);
    const pageBuf = await getBuffer(client, bucket, pageKey, 'posting_page');
    const pageText = await decodeEntityText(pageBuf, pageRef.page_offset, pageRef.page_length, 'posting_page', pageKey);
    if (sha256Bytes(Buffer.from(pageText, 'utf-8')) !== pageRef.page_sha256) {
        throw new Error(`[ACTIVATE] graph family "${id}" page_sha256 mismatch: ${pageKey}`);
    }
    const rows = JSON.parse(pageText);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.record_locator) {
        throw new Error(`[ACTIVATE] graph family "${id}" projection page row has no record_locator: ${pageKey}`);
    }

    // (3) embedded RecordLocator -> canonical record.
    const loc = row.record_locator;
    const canonKey = resolveShard(objectPrefix, loc.shard_key);
    const canonBuf = await getBuffer(client, bucket, canonKey, 'canonical_record');
    const recText = await decodeEntityText(canonBuf, loc.byte_offset, loc.byte_length, 'canonical_record', canonKey);
    let record;
    try { record = JSON.parse(recText); }
    catch (err) { throw new Error(`[ACTIVATE] graph family "${id}" canonical record not JSON: ${canonKey} (${err.message})`); }
    if (contentHash(record) !== loc.content_hash) {
        throw new Error(`[ACTIVATE] graph family "${id}" canonical content_hash mismatch: ${canonKey} `
            + `(locator=${loc.content_hash})`);
    }
    if (String(record.id ?? record.canonical_id) !== String(loc.canonical_id)) {
        throw new Error(`[ACTIVATE] graph family "${id}" canonical_id mismatch: `
            + `record=${record.id ?? record.canonical_id} locator=${loc.canonical_id}`);
    }
    if (loc.content_hash !== row.canonical_content_hash) {
        throw new Error(`[ACTIVATE] graph family "${id}" row canonical_content_hash != locator content_hash`);
    }
    if (String(row.canonical_id) !== String(loc.canonical_id)) {
        throw new Error(`[ACTIVATE] graph family "${id}" row canonical_id != locator canonical_id`);
    }
}
