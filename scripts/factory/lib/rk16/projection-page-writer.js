/**
 * RK-16A2 — projection page writer (PURE MECHANISM, OFFLINE/FIXTURE only).
 *
 * Groups the projection rows for ONE index_key into PAGES — ONE PAGE = ONE NXVF
 * ENTITY (one writeEntity per page). A page is SEALED the moment ANY of the three
 * PageSizePolicy ceilings hits FIRST:
 *   - record_count_target      (row count)
 *   - compressed_bytes_ceiling (estimated compressed page payload size)
 *   - parsed_heap_ceiling      (uncompressed JSON byte size, a heap proxy)
 *
 * Per page it returns a PostingPageRef (refs.ts shape): cursor_min/max = first/
 * last record sort key in the page; page_sha256 = sha256 of the page payload
 * bytes (the uncompressed UTF-8 JSON the entity carries).
 *
 * Each projection ROW MUST already carry: canonical_id, record_locator,
 * canonical_content_hash, projection_schema_version, projection_hash. This writer
 * stamps projection_hash (sha256 of the row's canonical bytes) if absent and
 * validates the required fields are present (FAILS LOUD otherwise).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ShardWriter } from '../shard-writer.js';
import { zstdCompressSync } from '../zstd-helper.js';
import { sha256Bytes, projectionHash } from './content-hash.js';

function freshTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rk16-proj-'));
}

const REQUIRED_ROW_FIELDS = [
    'canonical_id', 'record_locator', 'canonical_content_hash',
    'projection_schema_version',
];

function ensureRow(row) {
    for (const f of REQUIRED_ROW_FIELDS) {
        if (row[f] === undefined || row[f] === null) {
            throw new Error(`[PROJECTION-PAGE] row missing required field "${f}"`);
        }
    }
    if (!row.projection_hash) {
        return { ...row, projection_hash: projectionHash(row) };
    }
    return row;
}

/** Sort key used for cursor_min/max + page ordering: the canonical_id (record id). */
function sortKey(row) { return String(row.canonical_id); }

/**
 * Has `pageRows` (the current page AFTER appending a row) reached ANY ceiling?
 * Seals on whichever of the three hits FIRST. compressed_bytes uses zstd of the
 * current payload.
 */
function reachedCeiling(pageRows, policy) {
    if (pageRows.length === 0) return false;
    if (pageRows.length >= policy.record_count_target) return true;
    const payload = Buffer.from(JSON.stringify(pageRows), 'utf-8');
    if (payload.length >= policy.parsed_heap_ceiling) return true;
    const compressed = zstdCompressSync(payload, 3);
    if (compressed.length >= policy.compressed_bytes_ceiling) return true;
    return false;
}

/**
 * @param {object[]} rows  projection rows for ONE index key
 * @param {object} policy  PageSizePolicy {record_count_target, compressed_bytes_ceiling, parsed_heap_ceiling}
 * @param {object} opts { shardKey?, outputDir?, namePrefix? }
 * @returns {{ shard_key, shard_bytes:Buffer, page_refs:object[], page_total:number, entity_count:number }}
 */
export async function writeProjectionPages(rows, policy, opts = {}) {
    const namePrefix = opts.namePrefix || 'projection-shard';
    const outputDir = opts.outputDir || freshTmpDir();
    const shardKey = opts.shardKey || `${namePrefix}-000.bin`;

    const prepared = rows.map(ensureRow).sort((a, b) => {
        const ka = sortKey(a), kb = sortKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const writer = new ShardWriter(outputDir, namePrefix);
    await writer.init();
    const name = writer.open();

    const page_refs = [];
    let current = [];

    const flush = () => {
        if (current.length === 0) return;
        const payload = Buffer.from(JSON.stringify(current), 'utf-8');
        const { offset, size } = writer.writeEntity(payload);
        page_refs.push({
            kind: 'posting_page_ref',
            shard_key: shardKey,
            page_offset: offset,
            page_length: size,
            record_count: current.length,
            cursor_min: sortKey(current[0]),
            cursor_max: sortKey(current[current.length - 1]),
            page_sha256: sha256Bytes(payload),
        });
        current = [];
    };

    for (const row of prepared) {
        current.push(row);
        // Seal as soon as the current page reaches ANY of the three ceilings.
        if (reachedCeiling(current, policy)) {
            flush();
        }
    }
    flush();
    writer.finalize();

    const shard_bytes = fs.readFileSync(path.join(outputDir, name));
    return {
        shard_key: shardKey,
        shard_bytes,
        page_refs,
        page_total: page_refs.length,
        entity_count: writer.entityOffsets.length,
    };
}
