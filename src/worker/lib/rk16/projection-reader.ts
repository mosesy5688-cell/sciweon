/**
 * RK-16A2 — projection page reader (PURE MECHANISM, in-memory bytes only).
 *
 * Reads ONE projection page (1 page = 1 NXVF entity) by its PostingPageRef:
 *   slice [page_offset, +page_length) -> decryptPayload -> decompressPayload
 *   (STRICT) -> verify sha256(payload bytes) === page_sha256 (THROW on mismatch)
 *   -> JSON.parse -> projection rows.
 *
 * Operates on in-memory shard bytes — NO R2, NO network. NOT wired into the
 * live worker in A2.
 */

import type { Env } from '../../../worker';
import type { PostingPageRef } from './refs';
import { isPostingPageRef } from './refs';
import type { ProjectionRowBase } from './family-policy';
import { decryptPayload, decompressPayload } from '../shard-codec';
import { sha256Bytes } from './canonical-hash';

export class PageIntegrityError extends Error {
    constructor(expected: string, actual: string, shardKey: string) {
        super(
            `[PROJECTION-READER] page_sha256 mismatch in shard="${shardKey}" ` +
            `(expected=${expected}, actual=${actual}) — page bytes corrupted.`,
        );
        this.name = 'PageIntegrityError';
    }
}

/**
 * @param shardBytes      full shard bytes (in memory)
 * @param postingPageRef  the PostingPageRef addressing one projection page
 * @param env             worker Env (decryptPayload passthrough when no key)
 */
export async function readProjectionPage<R extends ProjectionRowBase = ProjectionRowBase>(
    shardBytes: Uint8Array,
    postingPageRef: PostingPageRef,
    env: Env,
): Promise<R[]> {
    if (!isPostingPageRef(postingPageRef)) {
        throw new Error('[PROJECTION-READER] not a PostingPageRef');
    }
    const { page_offset, page_length, shard_key, page_sha256 } = postingPageRef;
    const slice = shardBytes.subarray(page_offset, page_offset + page_length);
    const plain = decryptPayload(slice, shard_key, page_offset, env);
    const text = decompressPayload(plain, true); // STRICT decode

    // page_sha256 is over the UNCOMPRESSED UTF-8 payload bytes (producer side).
    const payloadBytes = new TextEncoder().encode(text);
    const actual = await sha256Bytes(payloadBytes);
    if (actual !== page_sha256) {
        throw new PageIntegrityError(page_sha256, actual, shard_key);
    }
    return JSON.parse(text) as R[];
}
