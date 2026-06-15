/**
 * RK-16 SIZING PROBE -- PURE metric helpers (no I/O, no R2). Percentiles,
 * degree-distribution bucketing, the union/dangling edge reconciliation, and
 * the clearly-labeled SIZING ESTIMATES (canonical shard bytes, posting-entry
 * count, index size, page counts, worst-case page reads). Every "estimate"
 * here is an INPUT for a future real spike -- NOT a measured value, NOT a
 * substitute for building shards. Unit-testable against tiny canned inputs.
 */

// -- percentiles over a numeric array (per-record byte lengths) ----------------

/** Nearest-rank percentile (p in [0,100]); empty -> 0. */
export function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 0;
    if (p <= 0) return sortedAsc[0];
    if (p >= 100) return sortedAsc[sortedAsc.length - 1];
    const rank = Math.ceil((p / 100) * sortedAsc.length);
    return sortedAsc[Math.min(rank, sortedAsc.length) - 1];
}

/** {avg,p50,p95,max} over a numeric array (copies + sorts ascending). */
export function byteStats(values) {
    if (!values.length) return { avg: 0, p50: 0, p95: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, v) => a + v, 0);
    return {
        avg: sum / sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted[sorted.length - 1],
    };
}

// -- degree distribution: a Map<id, count> -> histogram buckets ----------------

// Fixed log-ish buckets so the report is stable across runs/snapshots.
export const DEGREE_BUCKETS = Object.freeze([
    { label: '1', lo: 1, hi: 1 },
    { label: '2-5', lo: 2, hi: 5 },
    { label: '6-10', lo: 6, hi: 10 },
    { label: '11-50', lo: 11, hi: 50 },
    { label: '51-100', lo: 51, hi: 100 },
    { label: '101-500', lo: 101, hi: 500 },
    { label: '501-1000', lo: 501, hi: 1000 },
    { label: '1001+', lo: 1001, hi: Infinity },
]);

/**
 * Bucket a degree Map into a stable histogram + summary stats. `degreeMap` is
 * id -> integer count. Returns { buckets:{label:count}, distinct, max_degree,
 * max_degree_id, total_edges }.
 */
export function degreeDistribution(degreeMap) {
    const buckets = {};
    for (const b of DEGREE_BUCKETS) buckets[b.label] = 0;
    let max = 0, maxId = null, total = 0;
    for (const [id, deg] of degreeMap) {
        total += deg;
        if (deg > max) { max = deg; maxId = id; }
        for (const b of DEGREE_BUCKETS) {
            if (deg >= b.lo && deg <= b.hi) { buckets[b.label] += 1; break; }
        }
    }
    return { buckets, distinct: degreeMap.size, max_degree: max, max_degree_id: maxId, total_edges: total };
}

/** Generic value-frequency tally (is_active, activity_type) over a Map<v,count>. */
export function distFromMap(map) {
    const out = {};
    for (const [k, v] of map) out[String(k)] = v;
    return out;
}

// -- edge reconciliation (papers family) --------------------------------------

/**
 * Union of paper-links edges AND served mentioned_compounds edges, deduped by
 * `compound_id::paper_id`. `linkEdges` + `mentionEdges` are arrays of
 * {compound_id, paper_id}. Returns { union_edge_count, paper_links_edge_count,
 * mention_edge_count }.
 */
export function unionEdgeCount(linkEdges, mentionEdges) {
    const seen = new Set();
    for (const e of linkEdges) seen.add(`${e.compound_id}::${e.paper_id}`);
    for (const e of mentionEdges) seen.add(`${e.compound_id}::${e.paper_id}`);
    return {
        union_edge_count: seen.size,
        paper_links_edge_count: linkEdges.length,
        mention_edge_count: mentionEdges.length,
    };
}

/**
 * paper-links edges whose paper_id is NOT in the canonical papers id Set
 * (dangling references). `linkEdges` array of {paper_id}; `paperIds` a Set.
 */
export function danglingEdgeCount(linkEdges, paperIds) {
    let n = 0;
    for (const e of linkEdges) if (!paperIds.has(e.paper_id)) n += 1;
    return n;
}

/** Fraction (0..1) of `withCount` over `total`; total 0 -> 0. */
export function fraction(withCount, total) {
    return total > 0 ? withCount / total : 0;
}

// -- SIZING ESTIMATES (clearly-labeled inputs, NOT measured) -------------------

// Assumed per-posting-entry encoded byte size (id-ref + varint payload). This is
// an ESTIMATE knob, surfaced in the evidence as `assumptions`, NOT a measured
// shard byte. A real spike must replace it.
export const ASSUMED_POSTING_ENTRY_BYTES = 16;
// Assumed canonical shard target byte size (the F4 shard sizing input).
export const ASSUMED_CANONICAL_SHARD_BYTES = 4 * 1024 * 1024; // 4 MiB
export const CANDIDATE_PAGE_SIZES = Object.freeze([64, 256]);

/**
 * Build the `sizing` block from the already-computed family metrics. ALL
 * outputs are labeled estimates: posting_entry_count is the sum of papers union
 * edges + bioactivity compound-edges + target-edges; index_size_estimate =
 * posting_entry_count * ASSUMED_POSTING_ENTRY_BYTES; page_count_under_*  =
 * ceil(posting_entry_count / pageSize); estimated_worst_case_page_reads uses
 * the max-degree compound/target. `inputs` carries the numbers needed.
 */
export function buildSizingEstimates(inputs) {
    const {
        papers_union_edge_count, bio_compound_edges, bio_target_edges,
        max_compound_degree, max_target_degree,
        entryBytes = ASSUMED_POSTING_ENTRY_BYTES,
        shardBytes = ASSUMED_CANONICAL_SHARD_BYTES,
        pageSizes = CANDIDATE_PAGE_SIZES,
    } = inputs;

    const posting_entry_count = papers_union_edge_count + bio_compound_edges + bio_target_edges;
    const index_size_estimate = posting_entry_count * entryBytes;

    const page_count_under_candidate_page_sizes = {};
    for (const ps of pageSizes) {
        page_count_under_candidate_page_sizes[String(ps)] = Math.ceil(posting_entry_count / ps);
    }

    const worst = {};
    const maxDeg = Math.max(max_compound_degree || 0, max_target_degree || 0);
    for (const ps of pageSizes) worst[String(ps)] = Math.ceil(maxDeg / ps);

    return {
        estimated_canonical_shard_bytes: shardBytes,
        posting_entry_count,
        index_size_estimate,
        page_count_under_candidate_page_sizes,
        estimated_worst_case_page_reads: worst,
        max_degree_used: maxDeg,
        assumptions: {
            assumed_posting_entry_bytes: entryBytes,
            assumed_canonical_shard_bytes: shardBytes,
            candidate_page_sizes: [...pageSizes],
            note: 'ALL sizing values are ESTIMATES (inputs for a future real spike), NOT measured shard bytes; entry byte size + shard target are assumptions.',
        },
    };
}

// -- read-only verdict (reuses the guard counters) ----------------------------

export function computeReadOnlyVerdict(client, snapshotIdMatch) {
    const put = client?.put_count ?? 0;
    const del = client?.delete_count ?? 0;
    const wa = client?.write_attempt_count ?? 0;
    const read_only_clean = put === 0 && del === 0 && wa === 0;
    return {
        read_command_counts: client?.readCounts ?? { list: 0, head: 0, get: 0 },
        put_count: put,
        delete_count: del,
        write_attempt_count: wa,
        read_only_clean,
        snapshot_id_match: Boolean(snapshotIdMatch),
        probe_pass: Boolean(read_only_clean && snapshotIdMatch),
    };
}
