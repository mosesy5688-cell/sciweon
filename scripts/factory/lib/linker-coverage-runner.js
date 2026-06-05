/**
 * Shared coverage-stage runner (PR-B coverage-ceiling) -- the scaffolding both
 * trial-linker.js and paper-linker.js wrap around their adapter-specific query.
 *
 * Extracted so each linker stays under the Art 5.1 250-line cap AND so the
 * cursored-advance + skip-if-fresh + coverage-invariant + R2 stamp/cursor commit
 * logic lives in ONE audited place (no drift between the two linkers). This is
 * the trial/paper analogue of drain-adapter-backlog.js (the enricher-side shared
 * drain) -- same no-silent-loss + terminal-commit discipline.
 *
 * Flow per run:
 *   1. read prior freshness stamps from R2 (state/linker-query-stamps/<source>)
 *   2. apply them onto compounds (compound.linkage.<stampField>)
 *   3. eligible = NOT fresh (skip-if-stamped within the freshness window)
 *   4. cursored slice via enrichment-cursor (advances across daily runs)
 *   5. caller's queryChunk(slice, nowIso) does the network + writes entity files,
 *      returns { queriedIds }
 *   6. COVERAGE-INVARIANT: eligible>0 && queried==0 -> THROW (no silent ceiling)
 *   7. terminal commit: write merged stamps + advanced cursor to R2 (LOUD on fail)
 *   8. shared LOUD telemetry (eligible / queried / skipped_fresh / cursor)
 *
 * PRESERVE-ALL: a CADENCE mechanism, never a cap. Every compound is reached in
 * O(N / chunk_size) runs; no Top-N / relevance / volume cut anywhere.
 */

import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './enrichment-cursor.js';
import { readStamps, writeStamps } from './linker-stamp-store.js';
import { isEligibleForQuery, assertCoverageProgress } from './linker-coverage.js';

/**
 * Apply prior stamps (Map: compound_id -> ISO) onto compounds in the shape
 * lib/linker-coverage reads (compound.linkage.<stampField>). Returns compounds.
 */
export function applyStampsToCompounds(compounds, stampsMap, stampField) {
    for (const c of compounds) {
        const prior = stampsMap.get(c.id);
        if (prior) {
            if (c.linkage == null || typeof c.linkage !== 'object') c.linkage = {};
            c.linkage[stampField] = prior;
        }
    }
    return compounds;
}

/**
 * Run the shared coverage stage. Returns { queriedCount, eligibleCount,
 * skippedFresh, nextCursor } for the caller's telemetry, or null when there was
 * nothing eligible this cycle (caller should no-op its output writes).
 *
 * @param {object} o
 * @param {string} o.label           linker LABEL (telemetry + HALT messages)
 * @param {string} o.source          R2 cursor/stamp namespace (e.g. 'trial_linker')
 * @param {string} o.stampField      'trials_queried_at' | 'papers_queried_at'
 * @param {number} o.freshnessDays    re-query window
 * @param {number} o.chunkSizeOverride  optional explicit chunk size (else cursor/default)
 * @param {object[]} o.compounds      loaded compound records
 * @param {number} o.nowMs            caller-captured Date.now() (determinism)
 * @param {string} o.nowIso          ISO of nowMs (the stamp value)
 * @param {(slice, nowIso) => Promise<{queriedIds: string[], queryErrorCount?: number}>} o.queryChunk
 *        does the network query + writes the entity output files for this chunk.
 *        queriedIds holds ONLY genuinely-queried (HTTP 200) compounds; a fetch
 *        failure is excluded (stays eligible) and counted in queryErrorCount.
 */
export async function runCoverageStage({
    label, source, stampField, freshnessDays, chunkSizeOverride,
    compounds, nowMs, nowIso, queryChunk,
}) {
    // 1-2. stamps.
    let stampsMap = new Map();
    try { stampsMap = await readStamps(source); }
    catch (err) { console.warn(`[${label}] Stamp read failed (${err.message}) -- treating as no prior stamps`); }
    applyStampsToCompounds(compounds, stampsMap, stampField);
    console.log(`[${label}] Loaded ${compounds.length} compounds | prior stamps: ${stampsMap.size}`);

    // 3. eligibility = NOT fresh.
    const eligible = compounds.filter(c => isEligibleForQuery(c, stampField, freshnessDays, nowMs));
    const skippedFresh = compounds.length - eligible.length;
    console.log(`[${label}] Eligible (stale/never-queried): ${eligible.length} | skipped (fresh < ${freshnessDays}d): ${skippedFresh}`);
    if (eligible.length === 0) {
        console.log(`[${label}] Nothing to do this cycle -- all compounds queried within the freshness window.`);
        return null;
    }

    // 4. cursored slice.
    let cursor = null;
    try { cursor = await readCursor(source); }
    catch (err) { console.warn(`[${label}] Cursor read failed (${err.message}) -- starting fresh`); }
    const chunkSize = chunkSizeOverride ?? cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    const chunk = chunkIterator(eligible, cursor, chunkSize);
    console.log(`[${label}] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | this-run slice=${chunk.slice.length} | wrapped=${chunk.wrapped}`);

    // 5. caller's network query + entity-file writes.
    const { queriedIds, queryErrorCount = 0 } = await queryChunk(chunk.slice, nowIso);
    const queriedCount = queriedIds.length;
    if (queryErrorCount > 0) {
        console.warn(`[${label}] query_error_count=${queryErrorCount} this run (fetch failures -> NOT stamped, stay eligible for retry)`);
    }

    // 6. COVERAGE-INVARIANT HARD-FAIL ([[cross_cycle_silent_data_loss]]). Now
    // EFFECTIVE against a total outage: when every compound in the chunk failed,
    // queriedIds=[] -> queried=0 -> THROW (LOUD), instead of stamping the chunk
    // fresh on transient errors and silently skipping it for the whole window.
    assertCoverageProgress(eligible.length, queriedCount, label);

    // 7. terminal commit: merged stamps + advanced cursor to R2 (LOUD on fail).
    const mergedStamps = new Map(stampsMap);
    for (const id of queriedIds) mergedStamps.set(id, nowIso);
    try {
        await writeStamps(source, mergedStamps);
        console.log(`[${label}] Stamps written to R2 | total=${mergedStamps.size} (+${queriedCount} this run)`);
    } catch (err) {
        console.error(`[${label}] Stamp write failed: ${err.message}`);
        throw err; // a lost stamp write re-queries the same compounds next run
    }
    const nextCursor = buildNextCursor({
        source, prev: cursor, chunkResult: chunk,
        processedCount: queriedCount, totalEligible: chunk.totalEligible, chunkSize,
    });
    try {
        await writeCursor(source, nextCursor);
        console.log(`[${label}] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
    } catch (err) {
        console.error(`[${label}] Cursor write failed: ${err.message}`);
        throw err; // a lost cursor write re-processes the same chunk next run
    }

    // 8. shared LOUD telemetry.
    console.log(`\n[${label}] === COVERAGE TELEMETRY (LOUD, per no-silent-loss) ===`);
    console.log(`  eligible:                ${eligible.length}`);
    console.log(`  compounds_queried:       ${queriedCount}`);
    console.log(`  query_error_count:       ${queryErrorCount}`); // fetch failures -> NOT stamped, stay eligible
    console.log(`  compounds_skipped_fresh: ${skippedFresh}`);
    console.log(`  cursor_position:         ${nextCursor.cursor_id ?? '(wrapped/null)'} | cycles_completed=${nextCursor.cycles_completed}`);
    console.log(`  stamps_total:            ${mergedStamps.size}`);

    return { queriedCount, queryErrorCount, eligibleCount: eligible.length, skippedFresh, nextCursor };
}
