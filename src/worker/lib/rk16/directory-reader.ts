/**
 * RK-16A2 — posting directory reader (PURE MECHANISM, in-memory bytes only).
 *
 * Reads ONE posting directory (1 directory = 1 NXVF entity, depth exactly 1) by
 * its PostingDirectoryRef:
 *   slice [directory_offset, +directory_length) -> decryptPayload ->
 *   decompressPayload (STRICT) -> verify sha256(payload bytes) ===
 *   directory_sha256 (THROW on mismatch) -> JSON.parse -> PostingPageRef[].
 *
 * A directory holds ONLY page refs (never another directory) — depth stays 1.
 * Operates on in-memory shard bytes — NO R2, NO network. NOT wired into the
 * live worker in A2.
 */

import type { Env } from '../../../worker';
import type { PostingDirectoryRef, PostingPageRef } from './refs';
import { isPostingDirectoryRef, isPostingPageRef } from './refs';
import { decryptPayload, decompressPayload } from '../shard-codec';
import { sha256Bytes } from './canonical-hash';

export class DirectoryIntegrityError extends Error {
    constructor(expected: string, actual: string, shardKey: string) {
        super(
            `[DIRECTORY-READER] directory_sha256 mismatch in shard="${shardKey}" ` +
            `(expected=${expected}, actual=${actual}) — directory bytes corrupted.`,
        );
        this.name = 'DirectoryIntegrityError';
    }
}

/**
 * @param shardBytes          full shard bytes (in memory)
 * @param postingDirectoryRef the PostingDirectoryRef addressing one directory
 * @param env                 worker Env (decryptPayload passthrough when no key)
 */
export async function readPostingDirectory(
    shardBytes: Uint8Array,
    postingDirectoryRef: PostingDirectoryRef,
    env: Env,
): Promise<PostingPageRef[]> {
    if (!isPostingDirectoryRef(postingDirectoryRef)) {
        throw new Error('[DIRECTORY-READER] not a PostingDirectoryRef');
    }
    const { directory_offset, directory_length, directory_shard_key, directory_sha256 } =
        postingDirectoryRef;
    const slice = shardBytes.subarray(directory_offset, directory_offset + directory_length);
    const plain = decryptPayload(slice, directory_shard_key, directory_offset, env);
    const text = decompressPayload(plain, true); // STRICT decode

    const payloadBytes = new TextEncoder().encode(text);
    const actual = await sha256Bytes(payloadBytes);
    if (actual !== directory_sha256) {
        throw new DirectoryIntegrityError(directory_sha256, actual, directory_shard_key);
    }

    const refs = JSON.parse(text) as unknown[];
    // Depth stays 1: every directory entry MUST be a page ref, never a directory.
    for (const r of refs) {
        if (!isPostingPageRef(r)) {
            throw new Error(
                '[DIRECTORY-READER] directory entry is not a PostingPageRef ' +
                '(directory_depth must be exactly 1 — no nested directories).',
            );
        }
    }
    return refs as PostingPageRef[];
}
