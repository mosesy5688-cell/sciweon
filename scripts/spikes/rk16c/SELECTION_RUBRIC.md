# RK-16C FULL-CORPUS SPIKE — PRE-REGISTERED SELECTION RUBRIC

**Version: `rk16c-fullcorpus-rubric-v1`.** This spec is COMMITTED BEFORE any full
corpus read. It is the single, versioned, machine-checkable basis on which a
matrix cell (record_count_target × partition_policy) is judged. The executable
companion is `lib/rubric.mjs` (same version token). A result is bound to the
exact rubric version it was judged under.

This spike MAY eliminate / propose / tighten. It may NOT raise any section-17
hard cap, lock production config, or authorize family implementation. A
"candidate" here is a CANDIDATE, never a ratified production decision.

> Corrected read set (M1): a production-scale read consumes EXACTLY the two
> snapshot-namespace keys — `snapshots/<id>/_snapshot.manifest.json` and
> `snapshots/<id>/bioactivities.jsonl.gz`. The mutable `snapshots/latest.json`
> alias is FORBIDDEN and appears in NO read path. The full run is gated on a
> founder-reviewed integrity lock (see the build report).

## A. Hard correctness gates (pass/fail — ANY failure => NOT a candidate)

Each gate must be `true` for a cell to be eligible. A failing gate disqualifies
the cell outright (it is recorded, never silently dropped).

1. `all_input_rows_processed` — every input row is deterministically processed.
2. `no_silent_row_drop` — processed_rows == total_rows; no row vanishes.
3. `no_illegal_duplicate_attribution` — no row attributed to more than one
   illegal owner (1 row → exactly one partition).
4. `partition_assignment_replayable` — re-running yields the identical
   partition assignment (the partition function is pure).
5. `directory_refs_complete` — every page is reachable via the directory/page
   refs (no dangling / missing page).
6. `cursor_terminates` — the bounded cursor walk halts and traverses every row
   (no runaway, no scan-to-fill).
7. `output_checksum_passes` — every page sha256 verifies.
8. `no_hidden_global_on_heap` — no hidden O(N) global structure held on heap
   (the page writer streams).
9. `within_heap_ceiling` — no over-heap-ceiling execution (per-page parsed heap
   ≤ the A1 4 MiB hard cap, NEVER raised).

## B. Comparative metrics (OUTPUT ALL for every cell)

total_rows, processed_rows; degree_max, degree_p50, degree_p95, degree_p99,
degree_p99.9; partition_count, non_empty_partition_count; rows/partition
min/median/p95/p99/max; page_count; directory_bytes; data_bytes; temp_bytes;
peak_heap; cursor_rounds; total_logical_reads; total_physical_reads (where
observable); bytes_read; wall_clock; bounded_failures.

A missing metric is a defect (`assertMetricsComplete` throws).

## C. Tie-breaking (in strict precedence order)

1. **Correctness is a precondition.** Cells failing any hard gate are already
   excluded before tie-breaking.
2. **A hard memory OR read-budget failure ELIMINATES the cell** (`over_heap_ceiling`
   or `over_read_budget`), even if other metrics look attractive.
3. **Do NOT pick on a single metric** — not the smallest file, not the fastest
   single number. Selection uses a composite, tail-risk-weighted score.
4. **Prefer SIMPLER structure** — fewer partitions, shallower/fewer directory
   pages.
5. **Prefer LOWER TAIL RISK** — smaller p99 / p99.9 rows-per-partition and a
   smaller page-count tail.
6. **Prefer a PREDICTABLE budget** — bounded cursor_rounds and bounded
   worst-case per-request reads.

## D. NO RATIFIABLE CANDIDATE

**If NO cell satisfies every hard gate without a hard memory/read-budget
failure, the outcome is `NO_RATIFIABLE_CANDIDATE`.** The rubric returns
`{ ratifiable: false, outcome: 'NO_RATIFIABLE_CANDIDATE' }` with the reason and
the full judged set. In that case the spike proposes NOTHING for ratification;
the parameter selection is re-opened, not forced. A "least-bad" cell is NEVER
promoted to a candidate to avoid this outcome.
