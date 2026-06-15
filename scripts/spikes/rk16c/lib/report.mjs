/**
 * RK-16C OFFLINE SPIKE — Markdown report renderer (OFFLINE, pure formatting).
 *
 * Renders the aggregated spike results object into the human-readable artifact
 * RK16C_BIOACTIVITIES_OFFLINE_SPIKE_RESULTS.md. Pure string formatting — no I/O,
 * no substrate, no decisions. Every corpus-derived number is labeled
 * CORPUS-GROUNDED; every heavy-hitter number SYNTHETIC / PARAMETER CANDIDATE.
 */

const KiB = 1024;
function kib(n) { return `${Math.round((n / KiB) * 10) / 10} KiB`; }
function bool(b) { return b ? 'PASS' : 'FAIL'; }

function matrixTable(combos) {
    const head = '| record_target | compressed_ceiling | pages | avg comp | p95 comp | avg parsed | p95 parsed | max parsed heap | within 4MiB cap | deterministic |\n'
        + '|---|---|---|---|---|---|---|---|---|---|';
    const rows = combos.map((c) =>
        `| ${c.record_target} | ${c.compressed_ceiling} | ${c.pages} | ${kib(c.compressed_bytes.avg)} | ${kib(c.compressed_bytes.p95)} | ${kib(c.parsed_bytes.avg)} | ${kib(c.parsed_bytes.p95)} | ${kib(c.max_parsed_heap_bytes)} | ${bool(c.within_parsed_heap_cap)} | ${bool(c.deterministic)} |`);
    return [head, ...rows].join('\n');
}

function partitionTable(strategies) {
    const head = '| strategy | partitions | total pages | cursor rounds (est) |\n|---|---|---|---|';
    const rows = strategies.map((s) =>
        `| ${s.strategy} | ${s.partitions} | ${s.total_pages} | ${s.cursor_rounds_full_read_estimate} |`);
    return [head, ...rows].join('\n');
}

export function renderMarkdown(o) {
    const p = o.corpus_provenance;
    const hh = o.heavy_hitter;
    const w = hh.worst_case_single_request_reads;
    const sel = o.parameter_matrix.selected_candidate;
    const ri = o.referential_integrity;
    return `# RK-16C Bioactivities Offline Spike — Results

**OFFLINE substrate-conformance + parameter-selection experiment.** NO production
R2, NO network, NO workflow dispatch. NO family registered. NO inventory / F4 /
reader / latest / API / wrangler change. NO activatable production candidate. The
spike MAY eliminate / propose / tighten; it may NOT raise any section-17 hard
cap, lock production config, or authorize family implementation.

## Corpus provenance (CORPUS-GROUNDED inputs)
- source_path: \`${p.source_path}\`
- sha256: \`${p.sha256}\`
- record_count: ${p.record_count}
- note: ${p.note}

## Canonical authority
- record_total: ${o.canonical.record_total}; entity_count: ${o.canonical.entity_count}
- 1 record = 1 NXVF entity, stored once: **${bool(o.canonical.canonical_once)}**
- key: ${o.canonical.key_example}
- canonical shard sha256: \`${o.canonical.shard_sha256}\`

## Two materialized axes (CORPUS-GROUNDED)
- **compound axis** key = row compound_id — distinct_keys=${o.compound_axis.distinct_keys}, pages=${o.compound_axis.total_pages}, two_level_keys=${o.compound_axis.two_level_keys}, max_degree=${o.compound_axis.max_degree}
- **target axis** key = \`chembl:<target_id>\` (REQUIRED top-level target_id = authority) — distinct_keys=${o.target_axis.distinct_keys}, pages=${o.target_axis.total_pages}, two_level_keys=${o.target_axis.two_level_keys}, max_degree=${o.target_axis.max_degree}
- **uniprot vs target_id coverage**: target_id ${o.target_axis.uniprot_alias.target_id_coverage_pct}% (authority) vs uniprot ${o.target_axis.uniprot_alias.uniprot_coverage_pct}% (optional alias). rows_with_uniprot_alias=${o.target_axis.uniprot_alias.rows_with_uniprot_alias}, distinct_alias_keys=${o.target_axis.uniprot_alias.distinct_uniprot_alias_keys}. ${o.target_axis.uniprot_alias.note}

## Projection == project(canonical, policy)
- rows_checked=${o.projection_equals_project.rows_checked}, mismatches=${o.projection_equals_project.mismatches}
- projection is a pure, reproducible function: **${bool(o.projection_equals_project.projection_is_pure_function)}**
- LIST reads projection pages ONLY (0 canonical reads) — see read-budget proof.

## Parameter matrix (CORPUS-GROUNDED)
Subject: ${o.parameter_matrix.subject}. Seal on the FIRST of ${o.parameter_matrix.seal_on_first_of.join(', ')}. Hard parsed-heap cap = ${kib(o.parameter_matrix.parsed_heap_ceiling_bytes)} per page (NEVER raised).

${matrixTable(o.parameter_matrix.combos)}

**Selected candidate (${sel.label}):** record_count_target=${sel.record_count_target}, compressed_bytes_ceiling=${kib(sel.compressed_bytes_ceiling)}, parsed_heap_ceiling=${kib(sel.parsed_heap_ceiling)}. ${sel.note}

**Rejected sets + reasons:** record_target=128 (too many pages -> more cursor rounds + manifest/dir overhead at no heap benefit); compressed_ceiling=256KiB (seals early, inflates page count); record_target=1024 with 1MiB ceiling (largest parsed pages, closer to the 4 MiB cap with no serving benefit at corpus scale). 512 / 512KiB balances page count vs per-page heap while staying well under every hard cap.

## Heavy-hitter (SYNTHETIC / PARAMETER CANDIDATE)
- synthetic degree = ${hh.degree} (corpus has no such target; max corpus target degree = ${o.degree_distribution.target_id.max_degree})
- pages = ${hh.pages}; PageRef count > 64 -> mandatory two-level: **${bool(hh.mandatory_two_level)}** (directory_depth=${hh.directory_depth}, reason=${hh.reason})
- **LIST read-budget proof** (single request, worst case): control=${w.control} (<=4), posting=${w.posting} (<=4), canonical=${w.canonical} (==0), total=${w.total} (<=8) -> **${bool(hh.budget_proof_ok)}**
- full traversal across ${hh.list_walk_requests} bounded cursor requests; rows_traversed=${hh.rows_traversed}; complete=**${bool(hh.full_traversal_complete)}** (NO single-request scan-to-fill)
- ${hh.note}

## Partition comparison (CORPUS-GROUNDED)
Subject: ${o.partition_comparison.subject}.

${partitionTable(o.partition_comparison.strategies)}

**Winner (${o.partition_comparison.winner.label}): ${o.partition_comparison.winner.choice}.** ${o.partition_comparison.winner.rationale}

## Referential integrity (exhaustive)
- projection_record_count=${ri.projection_record_count}, canonical_resolved=${ri.canonical_resolved_count}
- dangling_reference_count=${ri.dangling_reference_count}, content_hash_mismatch_count=${ri.content_hash_mismatch_count}
- clean: **${bool(ri.clean)}**
- referential_integrity_attestation_hash: \`${ri.referential_integrity_attestation_hash}\` (substrate verification only, NOT a production seal)

## Determinism
- canonical shard byte-identical on rebuild: **${bool(o.determinism.canonical_shard_byte_identical)}** (sha256 match: ${bool(o.determinism.canonical_shard_sha256_match)})
- every matrix combo deterministic: **${bool(o.determinism.matrix_all_deterministic)}**

## Codec activation guard
- detected codec_impl: ${o.codec.detected_codec_impl}
- native artifact activatable: ${o.codec.native_artifact_activatable}
- WASM-fallback artifact activatable=false; assertActivatableCodec throws for WASM: **${bool(o.codec.wasm_assert_throws)}**
- ${o.codec.note}

## Remaining uncertainties
- **Production-scale follow-up (REQUIRED):** the corpus is 2026-05-13 / ${p.record_count} rows — smaller + older than production (~475,112) and has NO degree-43,364 target. The heavy-hitter results are SYNTHETIC. A production-scale corpus-grounded spike must re-validate page-size + partition selection at real degree + real value/comment cardinality.
- The selected page-size + P0 partition choices are CANDIDATES, not locked production config.
- Compressed-byte estimates use zstd level 3 (the substrate default); production dictionary effects are not modeled here.
- The cursor is UNSIGNED/offline; an HMAC is a precondition of any public cutover (explicitly out of scope).
`;
}
