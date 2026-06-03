/**
 * Compound RxNorm Enricher V1 (cycle 22 PR-CORE-2).
 *
 * Extracted from compound-id-resolver.js's chained UniChem -> RxNorm hop.
 * The chained design only ran RxNorm on compounds that resolved UNII in
 * the SAME pass, so the 24k UNII-bearing-but-no-rxcui backlog (PR-CORE-1
 * baseline 2026-05-23) was never reached. This standalone enricher walks
 * the full cumulative bundle via a persistent R2 cursor, applies a
 * skip-if-stamped guard, and resolves RxCUI for one chunk per cycle.
 *
 * Triple-lock anchor (per [[no_shortcut_in_science]]):
 *   - scale: cursor advances every cycle; UNII backlog reachable in
 *     O(N/chunk_size) cycles.
 *   - quality: skip-if-stamped uses the SOURCE_REQUIRED_FIELDS predicate
 *     (`external_ids.rxcui`) - same SSoT PR-CORE-1 measures against;
 *     no drift between "what completeness audit sees" and "what enricher
 *     considers done".
 *   - relational structure: cursor JSON at state/enrichment-cursor/rxnorm.json
 *     is the PR-CORE-2 contract counterpart to PR-CORE-1's state JSON.
 *
 * Skip semantics: a compound is skipped iff `external_ids.rxcui != null`.
 * Non-UNII compounds are eligible filter rejects (denominator gate).
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { resolveByUnii } from '../ingestion/adapters/rxnorm-adapter.js';
import { loadRxnormBulkMaps, lookupByUnii } from '../ingestion/adapters/rxnorm-bulk-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS } from './lib/drain-adapter-backlog.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const SOURCE = 'rxnorm';
const DATA_DIR = './output/linked';
const REQUEST_DELAY_MS = 150;
// Per-adapter drain wall-time budget (env override per [[solo_repo_branch_protection]]).
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 25 * 60 * 1000;
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || DEFAULT_CHUNK_DURATION_ESTIMATE_MS;

// Streaming JSONL writer (V5 architect-locked V8-thread defense). Releases
// the event loop between record writes via drain backpressure; avoids the
// 1.2-2.5s monolithic JSON.stringify freeze on 125MB+ master arrays.
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) {
            await once(stream, 'drain');
        }
    }
    stream.end();
    await once(stream, 'finish');
}

// Eligibility = UNII present and rxcui absent. Caller may pre-filter for
// the cursor's totalEligible count; chunkIterator slices through ALL
// eligible records in lex order.
export function isEligible(record) {
    return record?.external_ids?.unii != null && record?.external_ids?.rxcui == null;
}

/**
 * PR-RXN-1d bulk fast-path single-record enricher. In-memory O(1) Map
 * lookup that byte-identically mirrors enrichOne's mutation shape (rxcui,
 * rxnorm_name, rxnorm_tty, sources[]) but uses the pre-loaded RxNorm
 * bulk Map instead of per-UNII HTTP. Field mapping: hit.preferred_str ->
 * record.rxnorm_name; hit.tty -> record.rxnorm_tty.
 *
 * Returns `true` iff a hit occurred AND the raw UNII differed from its
 * canonical (trim + uppercase) form -- caller buckets to
 * `unii_format_drift_count` telemetry per [[scope_vs_quality_validation_segregation]]
 * diagnostic signal. Returns `false` on bulk miss, ineligible record, or
 * hit-with-already-canonical input.
 *
 * Idempotent: records with existing rxcui short-circuit (no overwrite).
 * Pure: no I/O, no async, no exceptions on shape drift.
 */
export function bulkEnrichOne(record, maps) {
    if (!record?.external_ids?.unii) return false;
    if (record.external_ids.rxcui) return false;
    const raw = record.external_ids.unii;
    if (typeof raw !== 'string') return false;
    const canonical = raw.trim().toUpperCase();
    if (canonical.length === 0) return false;
    const hit = lookupByUnii(maps, canonical);
    if (!hit) return false;
    record.external_ids.rxcui = hit.rxcui;
    if (hit.preferred_str) record.external_ids.rxnorm_name = hit.preferred_str;
    if (hit.tty) record.external_ids.rxnorm_tty = hit.tty;
    if (!Array.isArray(record.external_ids.sources)) record.external_ids.sources = [];
    if (!record.external_ids.sources.includes('rxnorm')) record.external_ids.sources.push('rxnorm');
    return raw !== canonical;
}

// Single-record enricher used by chunk iteration. Returns updated record
// (mutated in place); caller writes back to JSONL. Adapter null result =
// no RxNorm match for this UNII (genuine negative, not an error).
export async function enrichOne(record) {
    const unii = record.external_ids?.unii;
    if (!unii) return record;
    const rxnorm = await resolveByUnii(unii);
    if (rxnorm?.rxcui) {
        record.external_ids = record.external_ids ?? {};
        record.external_ids.rxcui = rxnorm.rxcui;
        if (rxnorm.rxnorm_name) record.external_ids.rxnorm_name = rxnorm.rxnorm_name;
        if (rxnorm.tty) record.external_ids.rxnorm_tty = rxnorm.tty;
        if (!Array.isArray(record.external_ids.sources)) {
            record.external_ids.sources = [];
        }
        if (!record.external_ids.sources.includes('rxnorm')) {
            record.external_ids.sources.push('rxnorm');
        }
    }
    return record;
}

async function main() {
    console.log(`[RXNORM-ENRICHER] V1 - cycle 22 PR-CORE-2 cursor-driven`);

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonlStrict(file);
    console.log(`[RXNORM-ENRICHER] Loaded ${compounds.length} compounds`);

    const eligible = compounds.filter(isEligible);
    console.log(`[RXNORM-ENRICHER] Eligible (UNII present, rxcui missing): ${eligible.length}`);

    if (eligible.length === 0) {
        console.log(`[RXNORM-ENRICHER] Nothing to do - all UNII-bearing compounds already have rxcui or no UNII present yet.`);
        return;
    }

    // PR-RXN-1d bulk fast-path: in-memory O(N) sweep before REST drain.
    // Replaces the ghost-component half-bridge where compound side was
    // locked to per-UNII HTTP while label side enjoyed bulk-Map O(1).
    // Fail-soft: bulk Map load failure -> log warn + skip; REST drain
    // still runs (degrades to pre-PR-1d behavior, never worse).
    let bulkMaps = null;
    try { bulkMaps = await loadRxnormBulkMaps(); }
    catch (err) {
        console.warn(`[RXNORM-ENRICHER] Bulk maps unavailable (${err.message}) -- skipping bulk fast-path; REST drain proceeds`);
    }
    if (bulkMaps) {
        let bulk_hits = 0;
        let unii_format_drift_count = 0;
        const eligible_entering = eligible.length;
        for (const rec of eligible) {
            const wasDrift = bulkEnrichOne(rec, bulkMaps);
            if (rec.external_ids?.rxcui) {
                bulk_hits++;
                if (wasDrift) unii_format_drift_count++;
            }
        }
        const rest_fallback_queued = eligible_entering - bulk_hits;
        const stampedNow = compounds.filter(r => r.external_ids?.rxcui).length;
        const coveragePct = ((stampedNow / Math.max(compounds.length, 1)) * 100).toFixed(2);
        const bulk_map_unii_keys = bulkMaps.uniiToRxcui?.size ?? 0;
        console.log(`[RXNORM-ENRICHER] Bulk fast-path: eligible_entering=${eligible_entering} bulk_hits=${bulk_hits} rest_fallback_queued=${rest_fallback_queued} unii_format_drift_count=${unii_format_drift_count} bulk_map_unii_keys=${bulk_map_unii_keys} coverage_after_bulk=${coveragePct}%`);
    }

    // Re-filter eligible after bulk pass: records stamped by bulkEnrichOne
    // are no longer isEligible, so the REST drain only processes long-tail
    // UNIIs not present in the RxNorm bulk map.
    const remainingEligible = eligible.filter(isEligible);
    if (remainingEligible.length === 0) {
        console.log(`[RXNORM-ENRICHER] Bulk fast-path cleared all eligible -- REST drain skipped; writing back and exiting.`);
        await writeJsonl(file, compounds);
        return;
    }
    console.log(`[RXNORM-ENRICHER] REST drain target: ${remainingEligible.length} long-tail UNIIs (not in bulk map)`);

    let cursor = null;
    try { cursor = await readCursor(SOURCE); }
    catch (err) { console.warn(`[RXNORM-ENRICHER] Cursor read failed (${err.message}) - starting fresh`); }
    const chunkSize = cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    console.log(`[RXNORM-ENRICHER] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | budget=${(DRAIN_BUDGET_MS / 60000).toFixed(1)}min | coldStart=${(COLD_START_MS / 60000).toFixed(1)}min`);

    // V5 drain-until-cleared: keep consuming chunks until corpus wraps,
    // EWMA budget gate fires, or eligible empty. Terminal commit AFTER drain.
    // Post-PR-RXN-1d: receives long-tail (bulk-map-missed) UNIIs only.
    const drain = await drainAdapterBacklog({
        eligible: remainingEligible, enrichOne, chunkIterator, chunkSize,
        timeBudgetMs: DRAIN_BUDGET_MS, coldStartEstimateMs: COLD_START_MS,
        sleepMsBetween: REQUEST_DELAY_MS, initialCursor: cursor,
        logPrefix: '[RXNORM-ENRICHER]', logEveryNRecords: 100,
    });
    console.log(`[RXNORM-ENRICHER] Drain done | terminatedBy=${drain.terminatedBy} | chunksDrained=${drain.chunksDrained} | processedInRun=${drain.processedInRun} | remainingBacklog=${drain.remainingBacklog}`);

    let hit = 0;
    for (const rec of compounds) { if (rec.external_ids?.rxcui) hit++; }

    // Terminal atomic commit: streaming local write then single cursor PUT.
    await writeJsonl(file, compounds);
    if (drain.finalCursorResult) {
        const nextCursor = buildNextCursor({
            source: SOURCE, prev: cursor,
            chunkResult: drain.finalCursorResult,
            processedCount: drain.processedInRun,
            totalEligible: drain.finalCursorResult.totalEligible,
        });
        try {
            await writeCursor(SOURCE, nextCursor);
            console.log(`[RXNORM-ENRICHER] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
        } catch (err) {
            console.error(`[RXNORM-ENRICHER] Cursor write failed: ${err.message}`);
            throw err;
        }
    } else {
        console.log('[RXNORM-ENRICHER] No chunks drained (empty eligible at entry) -- cursor unchanged');
    }

    console.log(`\n[RXNORM-ENRICHER] Complete - cumulative RxCUI count: ${hit}/${compounds.length}`);
}

// Run main only when invoked directly (not on import for tests).
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[RXNORM-ENRICHER] Fatal:', err); process.exit(1); });
}
