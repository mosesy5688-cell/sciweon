/**
 * SID Crosswalk — Phase 1.1b SID-S ↔ SID-C append-only table operations
 * per V1.0 §35 Dual-SID Architecture + §22 Permanence Doctrine.
 *
 * Crosswalk lives at state/sid-crosswalk/<entity_class>.jsonl.zst (per-class
 * sharding; sub-sharding can be added later if a class grows past ~10M
 * entries). Each entry links a structurally-derived SID-S to a counter-
 * governed SID-C with full provenance.
 *
 * Non-1:1 cases are first-class per V1.0 §35:
 *   - 1:1 default — one structure, one issuance, one SID-C per SID-S.
 *   - 1:N split — entity post-split keeps its original SID-S (still
 *     derivable from original anchor) and gains N new SID-Cs for the
 *     N descendants. bySidS therefore maps to an ARRAY of entries.
 *   - N:1 merge — impossible by construction since SID-C derives from a
 *     globally unique counter; if a merge produces a "winning" SID-C, the
 *     other SID-Cs persist permanently in the ledger and crosswalk, linked
 *     via Layer 2 SER edges (not by mutating the crosswalk).
 *
 * Append-only: crosswalk records are write-once. No deletions, no updates.
 * Retraction / withdrawal / supersession is handled via SER edges in Layer 2,
 * not by mutating the crosswalk. This is the V1.0 §22 Permanence Doctrine
 * applied to identity infrastructure.
 *
 * Pre-Phase-4 invariant: single-writer per entity_class. The append op
 * reads-modify-writes the whole compressed file; that's safe under single-
 * writer. Phase 4+ federation will add multi-writer atomicity via SER
 * edge protocol; this module's API stays stable.
 */

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export const CROSSWALK_PREFIX = 'state/sid-crosswalk/';

const SHARD_PREFIX_PATTERN = /^[0-9a-f]{2}$/;

/**
 * Phase 1.5: shardPrefix is INTERNAL — only set by lib/sid-stage3-shared.js
 * partitioned dispatcher. Orchestrators NEVER pass shardPrefix directly
 * (defect-13: static shardPrefix + global batch additions = mass double-
 * stamping hazard).
 */
export function crosswalkKey(entityClass, shardPrefix = null) {
    if (typeof entityClass !== 'string' || !entityClass) {
        throw new Error('[SID-crosswalk] entityClass required');
    }
    if (shardPrefix == null) {
        return `${CROSSWALK_PREFIX}${entityClass}.jsonl.zst`;
    }
    if (typeof shardPrefix !== 'string' || !SHARD_PREFIX_PATTERN.test(shardPrefix)) {
        throw new Error(`[SID-crosswalk] shardPrefix must be 2-char lowercase hex, got ${JSON.stringify(shardPrefix)}`);
    }
    return `${CROSSWALK_PREFIX}${entityClass}/${shardPrefix}.jsonl.zst`;
}

const REQUIRED_FIELDS = [
    'sid_s', 'sid_c', 'entity_class', 'canonicalization_version',
    'canonical_identity_payload', 'counter_value', 'reservation_id', 'issuance_at',
];

export function validateCrosswalkEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        throw new Error('[SID-crosswalk] entry must be object');
    }
    for (const f of REQUIRED_FIELDS) {
        const v = entry[f];
        if (f === 'counter_value') {
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
                throw new Error(`[SID-crosswalk] entry.${f} must be positive integer`);
            }
        } else if (typeof v !== 'string' || v.length === 0) {
            throw new Error(`[SID-crosswalk] entry.${f} required string`);
        }
    }
    return true;
}

export function parseCrosswalkLine(line) {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

export function parseCrosswalkJsonl(jsonlText) {
    if (typeof jsonlText !== 'string' || jsonlText.length === 0) return [];
    const out = [];
    for (const line of jsonlText.split('\n')) {
        const entry = parseCrosswalkLine(line);
        if (entry !== null) out.push(entry);
    }
    return out;
}

export function buildCrosswalkIndex(entries) {
    if (!Array.isArray(entries)) throw new Error('[SID-crosswalk] entries must be array');
    const bySidS = new Map();
    const bySidC = new Map();
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        if (typeof e.sid_s === 'string' && e.sid_s.length > 0) {
            const list = bySidS.get(e.sid_s);
            if (list) list.push(e); else bySidS.set(e.sid_s, [e]);
        }
        if (typeof e.sid_c === 'string' && e.sid_c.length > 0) {
            bySidC.set(e.sid_c, e);
        }
    }
    return { bySidS, bySidC };
}

export function lookupBySidS(index, sidS) {
    if (!index || !index.bySidS) return [];
    if (typeof sidS !== 'string' || sidS.length === 0) return [];
    return index.bySidS.get(sidS) || [];
}

export function lookupBySidC(index, sidC) {
    if (!index || !index.bySidC) return null;
    if (typeof sidC !== 'string' || sidC.length === 0) return null;
    return index.bySidC.get(sidC) || null;
}

export function serializeEntries(entries) {
    if (!Array.isArray(entries)) throw new Error('[SID-crosswalk] entries must be array');
    if (entries.length === 0) return '';
    const lines = entries.map(e => JSON.stringify(e));
    return lines.join('\n') + '\n';
}

export function mergeEntries(existing, additions) {
    if (!Array.isArray(existing)) throw new Error('[SID-crosswalk] existing must be array');
    if (!Array.isArray(additions)) throw new Error('[SID-crosswalk] additions must be array');
    return existing.concat(additions);
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

export async function loadCrosswalkRaw({ entityClass, client, bucket, shardPrefix = null }) {
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: crosswalkKey(entityClass, shardPrefix) }));
        return { compressedBuffer: await streamToBuffer(res.Body), etag: res.ETag };
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return { compressedBuffer: null, etag: null };
        }
        throw err;
    }
}

export const MAX_CROSSWALK_CAS_RETRIES = 5;

export function buildPutCrosswalkParams({ entityClass, compressedBuffer, ifMatch, ifNoneMatch, bucket, shardPrefix = null }) {
    if (!Buffer.isBuffer(compressedBuffer)) {
        throw new Error('[SID-crosswalk] compressedBuffer (zstd-compressed JSONL) required');
    }
    if (typeof bucket !== 'string' || !bucket) throw new Error('[SID-crosswalk] bucket required');
    const params = {
        Bucket: bucket, Key: crosswalkKey(entityClass, shardPrefix), Body: compressedBuffer,
        ContentType: 'application/octet-stream',
    };
    if (ifMatch) params.IfMatch = ifMatch;
    if (ifNoneMatch) params.IfNoneMatch = ifNoneMatch;
    return params;
}

export function isPreconditionFailed(err) {
    if (!err) return false;
    return err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412;
}

export async function putCrosswalkRaw({ entityClass, compressedBuffer, ifMatch, ifNoneMatch, client, bucket, shardPrefix = null }) {
    const params = buildPutCrosswalkParams({ entityClass, compressedBuffer, ifMatch, ifNoneMatch, bucket, shardPrefix });
    await client.send(new PutObjectCommand(params));
    return { key: crosswalkKey(entityClass, shardPrefix), byteSize: compressedBuffer.length };
}
