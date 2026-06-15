/**
 * RK-16C OFFLINE SPIKE — in-memory projection-page source (OFFLINE, no R2).
 *
 * Decodes ONE projection page from the in-memory shard bytes the reused A2
 * ShardWriter produced: slice [page_offset, +page_length) -> zstd-decompress
 * (encryption is passthrough/null offline) -> verify sha256(payload) ==
 * page_sha256 (FAIL LOUD) -> JSON.parse. This mirrors the worker TS
 * projection-reader contract; it exists only because the worker reader uses
 * extensionless TS imports the Node harness cannot resolve (the TS reader IS
 * exercised byte-for-byte in the vitest tests). NO network, NO production object.
 */

import { zstdDecompress } from '../../../factory/lib/zstd-helper.js';
import { sha256Bytes } from '../../../factory/lib/rk16/content-hash.js';

/**
 * @param {Buffer} shardBytes   full shard bytes (in memory)
 * @param {object} pageRef      PostingPageRef {page_offset,page_length,page_sha256}
 * @returns {object[]} the projection rows in the page
 */
export async function readProjectionPage(shardBytes, pageRef) {
    const { page_offset, page_length, page_sha256, shard_key } = pageRef;
    const slice = shardBytes.subarray(page_offset, page_offset + page_length);
    const payload = await zstdDecompress(slice);
    const actual = sha256Bytes(payload);
    if (actual !== page_sha256) {
        throw new Error(
            `[rk16c page-source] page_sha256 mismatch in ${shard_key} `
            + `(expected=${page_sha256}, actual=${actual})`,
        );
    }
    return JSON.parse(payload.toString('utf-8'));
}
