/**
 * RK-16C OFFLINE SPIKE — per-axis builder (OFFLINE/FIXTURE, no R2/network).
 *
 * Glue ONLY: composes the reused A2 substrate primitives (canonical writer,
 * projection-page writer, posting threshold/directory writer, partitioned
 * sublist) into one materialized axis for the spike. It reimplements NO
 * substrate mechanism — it imports them. Given a set of canonical records and a
 * keying function it produces, per index key, the projection pages + the flat-
 * or-two-level posting list, and (optionally) per-partition sublists.
 */

import { writeCanonicalShardAsync } from '../../../factory/lib/rk16/canonical-shard-writer.js';
import { writeProjectionPages } from '../../../factory/lib/rk16/projection-page-writer.js';
import { writePostingList } from '../../../factory/lib/rk16/posting-directory-writer.js';
import { decide } from '../../../factory/lib/rk16/posting-threshold.js';
import { buildPartitionedSublist } from '../../../factory/lib/rk16/partitioned-sublist.js';
import { rk16cFamilyPolicy } from './policy.mjs';

/** Write the single canonical store from corpus rows + return a locator index. */
export async function buildCanonical(rows, outputDir, shardKey = 'canon/shard-000.bin') {
    const records = rows.map((r) => ({ canonical_id: String(r.id), record: r }));
    const canon = await writeCanonicalShardAsync(records, { outputDir, shardKey });
    const byCanonicalId = new Map();
    for (const loc of canon.record_locators) byCanonicalId.set(loc.canonical_id, loc);
    return { canon, byCanonicalId, recordsById: indexById(rows) };
}

function indexById(rows) {
    const m = new Map();
    for (const r of rows) m.set(String(r.id), r);
    return m;
}

/** project() every row using its real locator (rows == project(canonical,loc)). */
export function projectRows(rows, byCanonicalId) {
    return rows.map((r) => {
        const loc = byCanonicalId.get(String(r.id));
        if (!loc) throw new Error(`[build-axis] no locator for ${r.id}`);
        return rk16cFamilyPolicy.project(r, loc);
    });
}

/** Group projection rows by an axis key (returns Map<key, row[]>). */
export function groupByKey(projRows, keyFn) {
    const map = new Map();
    for (const row of projRows) {
        const k = keyFn(row);
        if (k == null) continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(row);
    }
    return map;
}

/**
 * Materialize ONE index key: write its projection pages then decide flat vs
 * two-level. Returns the page refs + the posting list (flat array OR directory
 * ref) + the threshold decision.
 */
export async function materializeKey(rows, policy, outputDir, keyName) {
    const proj = await writeProjectionPages(rows, policy, {
        outputDir,
        shardKey: `proj/${safe(keyName)}.bin`,
    });
    const d = decide(proj.page_refs);
    const posting = await writePostingList(proj.page_refs, {
        outputDir,
        directoryShardKey: `dir/${safe(keyName)}.bin`,
    });
    return { page_refs: proj.page_refs, proj, decision: d, posting };
}

function safe(s) {
    return String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

/**
 * Build per-partition sublists for ONE index key using the GENERIC A2
 * partitioned-sublist primitive. The partition NAME function is supplied by the
 * caller (a family business choice, NOT hardcoded into the substrate).
 */
export async function buildPartitions(keyRows, policy, partitionOf, outputDir, keyName) {
    const buckets = new Map();
    for (const row of keyRows) {
        const p = partitionOf(row);
        if (!buckets.has(p)) buckets.set(p, []);
        buckets.get(p).push(row);
    }
    const entries = [];
    let pageCount = 0;
    for (const [partition_name, rows] of buckets) {
        const m = await materializeKey(rows, policy, outputDir, `${keyName}__${partition_name}`);
        pageCount += m.page_refs.length;
        entries.push({ partition_name, posting_list: m.posting.posting_list });
    }
    return {
        sublist: buildPartitionedSublist(entries),
        partition_count: buckets.size,
        page_count: pageCount,
        bucket_sizes: [...buckets.values()].map((b) => b.length),
    };
}
