/**
 * RK-16C OFFLINE SPIKE — page-size PARAMETER MATRIX (OFFLINE/FIXTURE).
 *
 * Sweeps record-target {128,256,512,1024} x compressed-ceiling
 * {256KiB,512KiB,1MiB} for a set of projection rows. The parsed-heap ceiling is
 * the HARD A1 per-page cap (4 MiB) — the spike never raises it. The page writer
 * (reused, NOT reimplemented) seals on the FIRST of {record_count,
 * compressed_bytes, parsed_heap}. For every combo it measures page count,
 * avg/p50/p95 compressed + parsed bytes, totals, and determinism (rebuild ==
 * byte-identical shard + identical page hashes).
 */

import { writeProjectionPages } from '../../../factory/lib/rk16/projection-page-writer.js';
import { zstdCompressSync } from '../../../factory/lib/zstd-helper.js';
import { sha256Bytes } from '../../../factory/lib/rk16/content-hash.js';

export const RECORD_TARGETS = [128, 256, 512, 1024];
export const COMPRESSED_CEILINGS = [
    { name: '256KiB', bytes: 256 * 1024 },
    { name: '512KiB', bytes: 512 * 1024 },
    { name: '1MiB', bytes: 1024 * 1024 },
];
/** HARD per-page parsed-heap cap from A1 read-budget (NEVER raised by the spike). */
export const PARSED_HEAP_CEILING = 4 * 1024 * 1024;

function quantile(sorted, q) {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
    return sorted[idx];
}
function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    return {
        avg: sorted.length ? Math.round(sum / sorted.length) : 0,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        total: sum,
        max: sorted.length ? sorted[sorted.length - 1] : 0,
    };
}

/** Measure ONE (record_target, compressed_ceiling) combo over `rows`. */
async function runCombo(rows, recordTarget, ceiling, outputDir) {
    const policy = {
        record_count_target: recordTarget,
        compressed_bytes_ceiling: ceiling.bytes,
        parsed_heap_ceiling: PARSED_HEAP_CEILING,
    };
    const shardKey = `matrix/rt${recordTarget}-${ceiling.name}.bin`;
    const a = await writeProjectionPages(rows, policy, { outputDir, shardKey });
    // determinism: rebuild and compare bytes + page hashes
    const b = await writeProjectionPages(rows, policy, { outputDir, shardKey });
    const deterministic = Buffer.compare(a.shard_bytes, b.shard_bytes) === 0
        && a.page_refs.length === b.page_refs.length
        && a.page_refs.every((p, i) => p.page_sha256 === b.page_refs[i].page_sha256);

    const parsedSizes = [];
    const compressedSizes = [];
    let maxParsed = 0;
    for (const pr of a.page_refs) {
        const pageRows = sliceRows(rows, a.page_refs, pr);
        const payload = Buffer.from(JSON.stringify(pageRows), 'utf-8');
        parsedSizes.push(payload.length);
        compressedSizes.push(zstdCompressSync(payload, 3).length);
        if (payload.length > maxParsed) maxParsed = payload.length;
    }
    const parsed = stats(parsedSizes);
    const compressed = stats(compressedSizes);
    return {
        record_target: recordTarget,
        compressed_ceiling: ceiling.name,
        pages: a.page_refs.length,
        parsed_bytes: parsed,
        compressed_bytes: compressed,
        total_compressed_bytes: compressed.total,
        max_parsed_heap_bytes: maxParsed,
        within_parsed_heap_cap: maxParsed <= PARSED_HEAP_CEILING,
        deterministic,
    };
}

/** Re-derive the rows in a page from the sorted full set + the page ref ordinal. */
function sliceRows(rows, allRefs, pr) {
    const sorted = [...rows].sort((x, y) => {
        const a = String(x.canonical_id), b = String(y.canonical_id);
        return a < b ? -1 : a > b ? 1 : 0;
    });
    let start = 0;
    for (const ref of allRefs) {
        if (ref === pr) break;
        start += ref.record_count;
    }
    return sorted.slice(start, start + pr.record_count);
}

/** Run the full matrix; return one row per combo. */
export async function runMatrix(rows, outputDir) {
    const combos = [];
    for (const rt of RECORD_TARGETS) {
        for (const ceiling of COMPRESSED_CEILINGS) {
            combos.push(await runCombo(rows, rt, ceiling, outputDir));
        }
    }
    return combos;
}

export { sha256Bytes };
