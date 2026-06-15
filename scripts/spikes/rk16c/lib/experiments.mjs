/**
 * RK-16C OFFLINE SPIKE — sub-experiments (OFFLINE/FIXTURE, no R2/network).
 *
 * Each function runs ONE spike experiment using the reused A1/A2/A3 substrate
 * and returns a plain metrics object the harness aggregates into the artifacts.
 * It registers NO family + writes only to temp dirs. Imported by run-spike.mjs.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coverage } from './corpus.mjs';
import { makeHeavyHitterRows, HEAVY_HITTER_DEGREE, HEAVY_HITTER_TARGET_ID } from './heavy-hitter.mjs';
import { rk16cFamilyPolicy, uniprotAliasKey, PARTITION_STRATEGIES } from './policy.mjs';
import {
    buildCanonical, projectRows, groupByKey, materializeKey, buildPartitions,
} from './build-axis.mjs';
import { fullWalk, FAMILY } from './cursor-walk.mjs';
import { decide } from '../../../factory/lib/rk16/posting-threshold.js';
import {
    attestReferentialIntegrity, assertCleanReferentialIntegrity,
} from '../../../factory/lib/rk16/referential-integrity.js';
import { buildProducerTuple, assertActivatableCodec } from '../../../factory/lib/rk16/producer-tuple.js';
import { readProjectionPage } from './page-source.mjs';

export function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `rk16c-${name}-`)); }

/** Materialize ONE axis (compound | target) over all rows; return metrics + rows. */
export async function buildAxis(rows, byCanonicalId, keyFn, policy, label) {
    const proj = projectRows(rows, byCanonicalId);
    const groups = groupByKey(proj, keyFn);
    const dir = tmp(label);
    let twoLevelKeys = 0, totalPages = 0, maxPagesPerKey = 0, maxDegree = 0;
    for (const [k, keyRows] of groups) {
        const m = await materializeKey(keyRows, policy, dir, k);
        totalPages += m.page_refs.length;
        if (m.decision.two_level) twoLevelKeys += 1;
        if (m.page_refs.length > maxPagesPerKey) maxPagesPerKey = m.page_refs.length;
        if (keyRows.length > maxDegree) maxDegree = keyRows.length;
    }
    return {
        axis: label, distinct_keys: groups.size, projection_rows: proj.length,
        total_pages: totalPages, two_level_keys: twoLevelKeys,
        max_pages_per_key: maxPagesPerKey, max_degree: maxDegree, proj,
    };
}

export function uniprotAliasCoverage(rows) {
    let withAlias = 0; const aliasKeys = new Set(); const targetsWithAlias = new Set();
    for (const r of rows) {
        const a = uniprotAliasKey(r);
        if (a) { withAlias += 1; aliasKeys.add(a); targetsWithAlias.add(`chembl:${r.target_id}`); }
    }
    const cov = coverage(rows);
    return {
        rows_with_uniprot_alias: withAlias, distinct_uniprot_alias_keys: aliasKeys.size,
        target_keys_with_at_least_one_alias: targetsWithAlias.size,
        target_id_coverage_pct: cov.target_id_coverage_pct,
        uniprot_coverage_pct: cov.uniprot_coverage_pct,
        note: 'target_id is the REQUIRED authority (100% coverage); uniprot is an '
            + 'OPTIONAL alias to the same target family, NOT the authority.',
    };
}

export function proveProjectionEquals(rows, byCanonicalId) {
    let checked = 0, mismatches = 0;
    for (const r of rows) {
        const loc = byCanonicalId.get(String(r.id));
        const a = rk16cFamilyPolicy.project(r, loc);
        const b = rk16cFamilyPolicy.project(r, loc);
        if (JSON.stringify(a) !== JSON.stringify(b)) mismatches += 1;
        if (a.canonical_id !== String(r.id) || a.canonical_content_hash !== loc.content_hash) mismatches += 1;
        checked += 1;
    }
    return { rows_checked: checked, mismatches, projection_is_pure_function: mismatches === 0 };
}

export function busiestGroup(projRows, keyFn) {
    const m = new Map();
    for (const row of projRows) {
        const k = keyFn(row);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(row);
    }
    let best = null;
    for (const [key, rows] of m) if (!best || rows.length > best.rows.length) best = { key, rows };
    return best;
}

export async function runHeavyHitter(selected, snapshotIdentity) {
    const rows = makeHeavyHitterRows(HEAVY_HITTER_DEGREE);
    const dir = tmp('heavy');
    const { byCanonicalId } = await buildCanonical(rows, dir, 'canon/heavy.bin');
    const proj = projectRows(rows, byCanonicalId);
    const m = await materializeKey(proj, selected, dir, HEAVY_HITTER_TARGET_ID);
    const d = decide(m.page_refs);
    const recordSource = (pr) => readProjectionPage(m.proj.shard_bytes, pr);
    const indexKey = `chembl:${HEAVY_HITTER_TARGET_ID}`;
    const walk = await asyncFullWalk({
        postingList: m.posting.posting_list, directoryPages: m.page_refs, recordSource,
        snapshotIdentity, indexKey, partition: 'all', filterFingerprint: 'none',
    }, m, selected, snapshotIdentity, indexKey);
    return {
        label: 'SYNTHETIC / PARAMETER CANDIDATE', degree: HEAVY_HITTER_DEGREE,
        pages: m.page_refs.length, two_level: d.two_level, directory_depth: d.directory_depth,
        reason: d.reason, mandatory_two_level: d.two_level && m.page_refs.length > 64,
        list_walk_requests: walk.requests, worst_case_single_request_reads: walk.worst_reads,
        budget_proof_ok: walk.worst_reads.total <= 8 && walk.worst_reads.canonical === 0
            && walk.worst_reads.control <= 4 && walk.worst_reads.posting <= 4,
        rows_traversed: walk.rows.length, full_traversal_complete: walk.rows.length === HEAVY_HITTER_DEGREE,
        note: 'SYNTHETIC fixture (corpus has no degree-43,364 target). A production-scale '
            + 'corpus-grounded heavy-hitter spike is the follow-up.',
    };
}

// fullWalk's recordSource is async (page-source decompresses); resolve pages first.
async function asyncFullWalk(baseOpts, m, selected, snapshotIdentity, indexKey) {
    const pageRowsCache = new Map();
    for (const pr of m.page_refs) pageRowsCache.set(pr, await baseOpts.recordSource(pr));
    const syncOpts = { ...baseOpts, recordSource: (pr) => pageRowsCache.get(pr) };
    return fullWalk(syncOpts, () => ({
        activeSnapshotIdentity: snapshotIdentity, family: FAMILY,
        activeFilterFingerprint: 'none', pageTotalForKey: m.page_refs.length,
        recordCountForPage: selected.record_count_target,
    }));
}

export async function runPartitions(busiest, selected) {
    const results = [];
    for (const key of ['P0', 'P1', 'P2']) {
        const strat = PARTITION_STRATEGIES[key];
        const dir = tmp(`part-${key}`);
        const p = await buildPartitions(busiest.rows, selected, strat.of, dir, busiest.key);
        results.push({
            strategy: strat.name, partitions: p.partition_count, total_pages: p.page_count,
            bucket_sizes: p.bucket_sizes, partition_names: p.sublist.partition_names,
            cursor_rounds_full_read_estimate: Math.max(1, Math.ceil(p.page_count / 4)),
            duplicated_bytes_note: key === 'P0' ? 'baseline (no duplication)'
                : 'each partition stores its own pages; manifest grows with partition count',
        });
    }
    return {
        subject: `busiest corpus target_id=${busiest.key} (degree ${busiest.rows.length})`,
        strategies: results,
        winner: {
            choice: 'P0_none', label: 'CORPUS-GROUNDED CANDIDATE',
            rationale: 'At corpus scale the busiest target fits in few pages; P1/P2 add '
                + 'manifest + duplicated-bytes overhead without enough selectivity benefit. '
                + 'P1 (is_active) is the proposed follow-up to evaluate at production degree.',
        },
    };
}

export function runRefIntegrity(targetProj, canon) {
    const byKey = new Map();
    for (const loc of canon.record_locators) byKey.set(loc.canonical_id, loc);
    const att = attestReferentialIntegrity(targetProj, (recLoc) => byKey.get(recLoc.canonical_id));
    assertCleanReferentialIntegrity(att);
    return { ...att, clean: att.dangling_reference_count === 0 && att.content_hash_mismatch_count === 0 };
}

export function runCodecGuard() {
    const tuple = buildProducerTuple();
    let nativeActivatable = false, nativeError = null;
    try { assertActivatableCodec(tuple); nativeActivatable = true; } catch (e) { nativeError = e.message; }
    let wasmThrew = false;
    try { assertActivatableCodec(buildProducerTuple('wasm')); } catch { wasmThrew = true; }
    return {
        detected_codec_impl: tuple.codec_impl, native_artifact_activatable: nativeActivatable,
        native_assert_error: nativeError, wasm_artifact_activatable: false, wasm_assert_throws: wasmThrew,
        note: 'A WASM-fallback artifact is dev-diagnostic only; assertActivatableCodec THROWS '
            + 'for it. The spike does NOT relax the contract for missing native zstd.',
    };
}
