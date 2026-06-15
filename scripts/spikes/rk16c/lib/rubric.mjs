/**
 * RK-16C FULL-CORPUS SPIKE (F) — machine-checkable PRE-REGISTERED RUBRIC.
 *
 * The executable companion to SELECTION_RUBRIC.md. It encodes the HARD
 * CORRECTNESS GATES (any failure => the cell is NOT a candidate), the full set
 * of COMPARATIVE METRICS to emit, and the TIE-BREAKING order (with the explicit
 * NO-RATIFIABLE-CANDIDATE outcome). Pure logic; no I/O. Versioned so a result
 * can be bound to the exact rubric it was judged under.
 */

export const RUBRIC_VERSION = 'rk16c-fullcorpus-rubric-v1';

/** Hard correctness gates — each MUST be true or the cell is disqualified. */
export const HARD_GATES = Object.freeze([
    'all_input_rows_processed',     // every input row deterministically processed
    'no_silent_row_drop',           // processed == total, none dropped
    'no_illegal_duplicate_attribution', // no row attributed to >1 illegal owner
    'partition_assignment_replayable',  // re-running yields identical assignment
    'directory_refs_complete',      // every page reachable via dir/page refs
    'cursor_terminates',            // the cursor walk halts (no runaway)
    'output_checksum_passes',       // output hashes verify
    'no_hidden_global_on_heap',     // no hidden O(N) global structure on heap
    'within_heap_ceiling',          // no over-heap-ceiling execution
]);

/** Comparative metrics every cell MUST output (names are the report columns). */
export const COMPARATIVE_METRICS = Object.freeze([
    'total_rows', 'processed_rows',
    'degree_max', 'degree_p50', 'degree_p95', 'degree_p99', 'degree_p999',
    'partition_count', 'non_empty_partition_count',
    'rows_per_partition_min', 'rows_per_partition_median',
    'rows_per_partition_p95', 'rows_per_partition_p99', 'rows_per_partition_max',
    'page_count', 'directory_bytes', 'data_bytes', 'temp_bytes', 'peak_heap',
    'cursor_rounds', 'total_logical_reads', 'total_physical_reads',
    'bytes_read', 'wall_clock_ms', 'bounded_failures',
]);

/**
 * Evaluate the hard gates for ONE cell's correctness object. Returns
 * { is_candidate, failed_gates }. A bounded-failure cell (bounded_failures>0
 * caused by a hard memory/read-budget breach) is recorded, NEVER silently
 * dropped — but it is NOT a candidate.
 */
export function evaluateHardGates(correctness) {
    const failed_gates = [];
    for (const g of HARD_GATES) {
        if (correctness[g] !== true) failed_gates.push(g);
    }
    return { is_candidate: failed_gates.length === 0, failed_gates };
}

/** Assert a cell emits ALL comparative metrics (a missing metric is a defect). */
export function assertMetricsComplete(metrics) {
    const missing = COMPARATIVE_METRICS.filter((m) => !(m in metrics));
    if (missing.length) {
        throw new Error(`[rubric] cell is missing comparative metrics: ${missing.join(', ')}`);
    }
    return true;
}

/**
 * Tie-breaking over the candidate cells (already passing every hard gate).
 * Order (each strictly dominates the next):
 *   1. correctness is a PRECONDITION (non-candidates are already excluded);
 *   2. ELIMINATE any cell with a hard memory OR read-budget failure;
 *   3. do NOT pick on a single metric (smallest file / fastest single number);
 *   4. prefer SIMPLER structure (fewer partitions, shallower directory);
 *   5. prefer LOWER TAIL RISK (smaller p99/p99.9 rows-per-partition + page tail);
 *   6. prefer a PREDICTABLE budget (cursor_rounds + worst-case reads bounded).
 * If NO candidate satisfies the gates => NO RATIFIABLE CANDIDATE.
 *
 * @param {object[]} cells  each { id, correctness, metrics }
 */
export function selectCandidate(cells) {
    const judged = cells.map((c) => ({
        ...c, gate: evaluateHardGates(c.correctness),
    }));
    const candidates = judged.filter((c) => c.gate.is_candidate
        && !hardBudgetFailure(c.metrics));

    if (candidates.length === 0) {
        return {
            rubric_version: RUBRIC_VERSION,
            ratifiable: false,
            outcome: 'NO_RATIFIABLE_CANDIDATE',
            reason: 'no cell passed every hard correctness gate without a hard '
                + 'memory/read-budget failure',
            considered: judged.length,
            judged,
        };
    }

    // Composite, tail-risk-weighted score (LOWER is better). Never a single metric.
    const scored = candidates
        .map((c) => ({ ...c, score: tailRiskScore(c.metrics) }))
        .sort((a, b) => a.score - b.score
            || a.metrics.partition_count - b.metrics.partition_count);

    return {
        rubric_version: RUBRIC_VERSION,
        ratifiable: true,
        outcome: 'CANDIDATE_SELECTED',
        winner: scored[0].id,
        ranking: scored.map((c) => ({ id: c.id, score: c.score })),
        considered: judged.length,
        judged,
    };
}

/** A cell is eliminated outright on a hard memory / read-budget breach. */
function hardBudgetFailure(m) {
    return m.over_heap_ceiling === true || m.over_read_budget === true;
}

/**
 * Composite score: simpler structure + lower tail risk + predictable budget.
 * Normalized, additive — NOT a single metric. Lower is better.
 */
function tailRiskScore(m) {
    const norm = (v, d) => (d > 0 ? (v || 0) / d : 0);
    return norm(m.partition_count, 16)          // simpler: fewer partitions
        + norm(m.page_count, 4096)              // simpler: fewer pages
        + norm(m.rows_per_partition_p999, m.rows_per_partition_max || 1) // tail risk
        + norm(m.cursor_rounds, 256)            // predictable budget
        + norm(m.peak_heap, 4 * 1024 * 1024);   // closeness to heap ceiling
}
