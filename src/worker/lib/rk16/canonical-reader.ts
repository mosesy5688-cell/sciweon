/**
 * RK-16A2 — canonical record reader (PURE MECHANISM, in-memory bytes only).
 *
 * Reads ONE canonical record (1 record = 1 NXVF entity) by its RecordLocator:
 *   slice [byte_offset, +byte_length) -> decryptPayload -> decompressPayload
 *   (STRICT) -> JSON.parse -> verify sha256(canonicalize(record)) ===
 *   recordLocator.content_hash (THROW on mismatch).
 *
 * Operates on in-memory shard bytes (a Uint8Array) — NO R2, NO network. `env` is
 * the worker Env (for decryptPayload passthrough); tests pass {SHARD_AES_KEY:
 * undefined}. NOT wired into the live worker in A2.
 */

import type { Env } from '../../../worker';
import type { RecordLocator } from './refs';
import { isRecordLocator } from './refs';
import { decryptPayload, decompressPayload } from '../shard-codec';
import { sha256Canonical } from './canonical-hash';

export class CanonicalIntegrityError extends Error {
    constructor(expected: string, actual: string, canonicalId: string) {
        super(
            `[CANONICAL-READER] content_hash mismatch for canonical_id="${canonicalId}" ` +
            `(expected=${expected}, actual=${actual}) — record bytes do not match locator.`,
        );
        this.name = 'CanonicalIntegrityError';
    }
}

/**
 * @param shardBytes    full shard bytes (in memory)
 * @param recordLocator the RecordLocator addressing one canonical record
 * @param env           worker Env (decryptPayload passthrough when no key)
 */
export async function readCanonicalRecord(
    shardBytes: Uint8Array,
    recordLocator: RecordLocator,
    env: Env,
): Promise<unknown> {
    if (!isRecordLocator(recordLocator)) {
        throw new Error('[CANONICAL-READER] not a RecordLocator');
    }
    const { byte_offset, byte_length, shard_key, content_hash, canonical_id } = recordLocator;
    const slice = shardBytes.subarray(byte_offset, byte_offset + byte_length);
    const plain = decryptPayload(slice, shard_key, byte_offset, env);
    const text = decompressPayload(plain, true); // STRICT: a decode failure is loud
    const record = JSON.parse(text);

    const actual = await sha256Canonical(record);
    if (actual !== content_hash) {
        throw new CanonicalIntegrityError(content_hash, actual, canonical_id);
    }
    return record;
}
