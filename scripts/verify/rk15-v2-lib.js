/**
 * RK-15 V2 — shared PURE logic + isolated-namespace R2 primitives.
 *
 * Extracted from rk15-v2-publish.js to stay under the CES 250-line cap and to
 * make the control logic unit-testable with a mock client. NOTHING here EVER
 * writes production snapshots/** or snapshots/latest.json: production latest is
 * GET-only (the before/after invariance check), and the ISOLATED-PREFIX GUARD
 * (assertIsolatedKey) hard-fails any write whose key is not under
 * rk15-verification/v2/.
 */

import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { isPreconditionFailed, isConditionalUnsupported } from '../factory/lib/snapshot-identity.js';
import { zstdDecompress } from '../factory/lib/zstd-helper.js';

export const PROD_LATEST_KEY = 'snapshots/latest.json';
export const ISOLATED_ROOT = 'rk15-verification/v2/';

export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

export async function streamToBuffer(body) {
    if (body == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    const chunks = [];
    for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
}

/** The ISOLATED-PREFIX GUARD. A write to any key NOT under rk15-verification/v2/
 * is a hard contract violation (a production write would be a FAIL). */
export function assertIsolatedKey(key) {
    if (typeof key !== 'string' || !key.startsWith(ISOLATED_ROOT)) {
        throw new Error(`[RK15-V2 GUARD] refusing a write outside the isolated namespace: ${JSON.stringify(key)} (must start with ${ISOLATED_ROOT})`);
    }
}

export function isCreateOnlyCollision(err) {
    return isPreconditionFailed(err)
        || /\[CREATE-ONLY\] object already exists/i.test(err?.message ?? '');
}

export function classifyError(err) {
    if (!err) return { name: null, httpStatus: null, message: null };
    return {
        name: err.name ?? null,
        httpStatus: err.$metadata?.httpStatusCode ?? null,
        message: err.message ?? String(err),
        preconditionFailed: isPreconditionFailed(err),
        createOnlyCollision: isCreateOnlyCollision(err),
        conditionalUnsupported: isConditionalUnsupported(err),
    };
}

/**
 * Wrap `client.send` so EVERY command is recorded AND every WRITE key is run
 * through the isolated-prefix guard BEFORE it reaches R2 (a write that would
 * escape the namespace throws here, never hitting the store). GET/HEAD are
 * read-only and not guarded (production latest is read intentionally). The
 * send-log records each PUT's conditional header for the no-unconditional audit.
 */
export function instrumentClient(realClient) {
    const log = [];
    return {
        sendLog: log,
        get callCount() { return log.length; },
        async send(command, ...rest) {
            const ctorName = command?.constructor?.name ?? 'UnknownCommand';
            const input = command?.input ?? {};
            const entry = { seq: log.length + 1, command: ctorName, key: input.Key ?? null };
            if (ctorName === 'PutObjectCommand') {
                assertIsolatedKey(input.Key); // GUARD: production writes are impossible.
                entry.put = {
                    ifNoneMatch: input.IfNoneMatch ?? null,
                    ifMatch: input.IfMatch ?? null,
                    conditional: input.IfNoneMatch != null || input.IfMatch != null,
                };
            }
            log.push(entry);
            try {
                const res = await realClient.send(command, ...rest);
                entry.ok = true;
                return res;
            } catch (err) {
                entry.ok = false;
                entry.errorName = err?.name ?? null;
                entry.httpStatus = err?.$metadata?.httpStatusCode ?? null;
                throw err;
            }
        },
    };
}

export function summarizePutConditionals(sendLog) {
    const puts = sendLog.filter(e => e.command === 'PutObjectCommand');
    const unconditional = puts.filter(e => e.put && e.put.conditional === false);
    return {
        putCount: puts.length,
        conditionalPutCount: puts.filter(e => e.put && e.put.conditional).length,
        unconditionalPutCount: unconditional.length,
        unconditionalKeys: unconditional.map(e => e.key),
        writtenKeys: puts.map(e => e.key),
    };
}

/** Every PUT key recorded in the send-log is under the isolated root. */
export function evalAllWritesIsolated(sendLog) {
    const puts = sendLog.filter(e => e.command === 'PutObjectCommand');
    const escaped = puts.map(e => e.key).filter(k => !k || !k.startsWith(ISOLATED_ROOT));
    if (escaped.length > 0) {
        return { pass: false, action: 'isolated-namespace audit', reason: `${escaped.length} PUT(s) escaped the isolated namespace`, escapedKeys: escaped };
    }
    return { pass: true, action: 'isolated-namespace audit', putCount: puts.length, isolatedRoot: ISOLATED_ROOT };
}

// ── isolated R2 primitives (production latest.json is GET-only) ──────────────

export async function getObject(client, bucket, key) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(res.Body);
    return { etag: res.ETag ?? null, body, sha256: sha256Hex(body) };
}

export async function headObject(client, bucket, key) {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { etag: res.ETag ?? null, size: res.ContentLength ?? res.Size ?? 0 };
}

export async function getObjectOrNull(client, bucket, key) {
    try { return await getObject(client, bucket, key); }
    catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

// ── NXVF V4.1 shard decode (the serving-side read-back) ──────────────────────

const NXVF_MAGIC = Buffer.from([0x4E, 0x58, 0x56, 0x46]);

/** Decode an NXVF container's entity at (offset,size): slice payload, detect zstd
 * + decompress. Mirrors the worker shard-codec serving path on real shard bytes. */
export async function decodeNxvfEntity(shardBuf, offset, size) {
    if (shardBuf.length < 29 || !shardBuf.subarray(0, 4).equals(NXVF_MAGIC)) {
        throw new Error('decodeNxvfEntity: not an NXVF container (bad magic / too short)');
    }
    const entityCount = shardBuf.readUInt32LE(11);
    if (entityCount <= 0) throw new Error('decodeNxvfEntity: NXVF container declares zero entities');
    const payload = shardBuf.subarray(offset, offset + size);
    // Phase 1 ships WITHOUT encryption (shard-crypto no-op) -> payload is raw
    // zstd. zstd magic 0x28B52FFD.
    if (payload.length >= 4 && payload.readUInt32LE(0) === 0xFD2FB528) {
        return await zstdDecompress(payload);
    }
    return Buffer.from(payload);
}

/** Resolve a compound record by CID from a manifest entry + its real shard bytes. */
export async function resolveCompoundFromShard(manifest, cid, shardBytesByShardId) {
    const entry = (manifest.entries ?? []).find(e => e.cid === cid);
    if (!entry) throw new Error(`resolveCompoundFromShard: CID ${cid} not in manifest`);
    const shardBuf = shardBytesByShardId.get(entry.shard);
    if (!shardBuf) throw new Error(`resolveCompoundFromShard: shard ${entry.shard} bytes not provided`);
    const decoded = await decodeNxvfEntity(shardBuf, entry.offset, entry.size);
    const rec = JSON.parse(decoded.toString('utf-8'));
    if (rec.pubchem_cid !== cid) throw new Error(`resolveCompoundFromShard: decoded CID ${rec.pubchem_cid} != requested ${cid}`);
    return rec;
}
