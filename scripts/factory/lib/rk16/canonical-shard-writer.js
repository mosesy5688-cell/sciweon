/**
 * RK-16A2 — canonical shard writer (PURE MECHANISM, OFFLINE/FIXTURE only).
 *
 * Writes canonical records ONE-PER-NXVF-ENTITY via the reused ShardWriter
 * (one writeEntity per record). Records are sorted by canonical_id ascending
 * BEFORE writing so the byte layout + sort_order are deterministic. For each
 * record it returns a RecordLocator (refs.ts shape) whose content_hash is the
 * sha256 of the record's CANONICAL bytes.
 *
 * Operates on a temp dir (caller supplies / a fresh one is made) and reads the
 * shard bytes back into memory — NO R2, NO network, NO production objects. NOT
 * wired into the worker or F4.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ShardWriter } from '../shard-writer.js';
import { sha256Bytes } from './content-hash.js';
import { contentHash } from './content-hash.js';

function freshTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rk16-canon-'));
}

/**
 * @param {Array<{canonical_id:string, record:object}>} records
 * @param {object} opts { shardKey?, outputDir?, namePrefix? }
 * @returns {{
 *   shard_key:string, shard_bytes:Buffer, record_locators:object[],
 *   shard_hashes:string[], record_total:number, entity_count:number
 * }}
 */
export function writeCanonicalShard(records, opts = {}) {
    const namePrefix = opts.namePrefix || 'canonical-shard';
    const outputDir = opts.outputDir || freshTmpDir();
    const shardKey = opts.shardKey || `${namePrefix}-000.bin`;

    // Sort by canonical_id ascending — the canonical byte order.
    const sorted = [...records].sort((a, b) =>
        a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0);

    const writer = new ShardWriter(outputDir, namePrefix);
    const initResult = writer.init();
    if (initResult && typeof initResult.then === 'function') {
        throw new Error('[canonical-shard-writer] writer.init() is async — call writeCanonicalShardAsync');
    }
    return finishWrite(writer, sorted, outputDir, shardKey);
}

/** Async variant (ShardWriter.init() is async because it warms the codec). */
export async function writeCanonicalShardAsync(records, opts = {}) {
    const namePrefix = opts.namePrefix || 'canonical-shard';
    const outputDir = opts.outputDir || freshTmpDir();
    const shardKey = opts.shardKey || `${namePrefix}-000.bin`;

    const sorted = [...records].sort((a, b) =>
        a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0);

    const writer = new ShardWriter(outputDir, namePrefix);
    await writer.init();
    return finishWrite(writer, sorted, outputDir, shardKey);
}

function finishWrite(writer, sorted, outputDir, shardKey) {
    const name = writer.open();
    const record_locators = [];
    for (const { canonical_id, record } of sorted) {
        const payload = Buffer.from(JSON.stringify(record), 'utf-8');
        const { offset, size } = writer.writeEntity(payload);
        record_locators.push({
            kind: 'record_locator',
            shard_key: shardKey,
            byte_offset: offset,
            byte_length: size,
            canonical_id,
            content_hash: contentHash(record),
        });
    }
    writer.finalize();

    const shard_bytes = fs.readFileSync(path.join(outputDir, name));
    return {
        shard_key: shardKey,
        shard_bytes,
        record_locators,
        shard_hashes: [sha256Bytes(shard_bytes)],
        record_total: sorted.length,
        entity_count: writer.entityOffsets.length,
    };
}
