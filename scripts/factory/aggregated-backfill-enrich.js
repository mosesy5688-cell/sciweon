/**
 * Aggregated Cumulative Backfill Enricher V1 (cycle 22 PR-CORE-3).
 *
 * Runs INSIDE stage-3-aggregate.js, AFTER mergeLocalAggregatedWithPrevious (so
 * compounds-enriched.jsonl is the freshly-merged cumulative) and BEFORE
 * buildSearchIndex (so downstream indices see the backfilled records).
 *
 * Closes the wiring arc PR-CORE-2 missed: F2 cursor enrichers see only the F1
 * increment (~5k), never the ~70k cumulative backlog. PR-CORE-3 walks the
 * cumulative via the SAME enrichOne + skip-if-stamped predicates, in a separate
 * cursor namespace state/aggregated-cursor/<source>.json. Triple-lock
 * ([[no_shortcut_in_science]]): full O(N/chunk) coverage; predicates ==
 * SOURCE_REQUIRED_FIELDS SSoT. D7/D8: per-source failure logs explicit, never
 * aborts. PR-RXN-1g adds F3-cumulative bridges (A) RxNorm bulk pre-pass +
 * (B) DailyMed re-link. PR-FACTORY3-OPENFDA-KEY: per-source FAERS budget +
 * FETCH_FAILURES-vs-SATURATION de-mask ([[cross_cycle_silent_data_loss]]).
 */

import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { readCursor, writeCursor, chunkIterator, buildNextCursor } from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS } from './lib/drain-adapter-backlog.js';
import { isEligible as isEligibleUnichem, enrichOne as enrichOneUnichem } from './compound-id-resolver.js';
import { isEligible as isEligibleRxnorm, enrichOne as enrichOneRxnorm, bulkEnrichOne as bulkEnrichOneRxnorm } from './compound-rxnorm-enricher.js';
import { isEligible as isEligibleFaers, enrichOne as enrichOneFaers, faersTelemetry } from './compound-faers-enricher.js';
import { loadRxnormBulkMaps } from '../ingestion/adapters/rxnorm-bulk-adapter.js';
import { relinkCumulativeDailymed } from './lib/dailymed-crosslink.js';
import { formatDailymedRelinkLog } from './lib/dailymed-relink-log.js';
import { buildCorpusAddList, emitCorpusAddList } from './lib/corpus-add-list-emit.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const DATA_DIR = './output/linked';
const COMPOUNDS_FILE = path.join(DATA_DIR, 'compounds-enriched.jsonl');
const DRUG_LABELS_FILE = path.join(DATA_DIR, 'drug-labels.jsonl');
const CURSOR_PREFIX = 'state/aggregated-cursor/';
const DEFAULT_BACKFILL_CHUNK = 2000;
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 25 * 60 * 1000;
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || DEFAULT_CHUNK_DURATION_ESTIMATE_MS;
// PR-FACTORY3-OPENFDA-KEY: TARGETED 60min budget for the openfda_faers uncap
// re-enrich (~40k eligible) -- drains faster WITHOUT extending unichem/rxnorm
// (shared 25min) or risking the F3 GHA timeout (last F3 ~180min; +35min under
// the 350min cap). Env: FAERS_BACKFILL_BUDGET_MS.
const FAERS_DRAIN_BUDGET_MS = Number(process.env.FAERS_BACKFILL_BUDGET_MS) || 60 * 60 * 1000;
// FETCH-FAILURE (not saturation) when a run's openFDA error count exceeds this
// fraction of records attempted (keyless ~=1.0; healthy ~=0). Env override too.
const FAERS_FETCH_FAILURE_RATIO = Number(process.env.FAERS_FETCH_FAILURE_RATIO) || 0.25;

// Per-source rate limits matching the underlying adapters. drainBudgetMs (opt):
// overrides the shared DRAIN_BUDGET_MS. telemetry (opt): returns cumulative
// { faersErrorCount, ... }; the drain snapshots a per-run delta to de-mask
// keyless saturation ([[cross_cycle_silent_data_loss]]).
const SOURCE_CONFIG = Object.freeze({
    unichem:       { delayMs: 250, enrichOne: enrichOneUnichem, isEligible: isEligibleUnichem },
    rxnorm:        { delayMs: 150, enrichOne: enrichOneRxnorm,  isEligible: isEligibleRxnorm, bulkEnrichOne: bulkEnrichOneRxnorm },
    openfda_faers: { delayMs: 250, enrichOne: enrichOneFaers,   isEligible: isEligibleFaers, drainBudgetMs: FAERS_DRAIN_BUDGET_MS, telemetry: faersTelemetry },
});

// Streaming JSONL writer (V5 architect-locked: per-record write, conditional
// drain await only on stream.write false return -- no microtask thrash).
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

// Run one source's backfill on the in-memory compounds list via V5
// drainAdapterBacklog. Returns { source, processed, stamped, error, fetchErrors }.
// Mutates compounds in place. Lock 1: drain scopes runStart per-call so
// sequential sources never inherit a polluted shared clock.
export async function backfillOneSource(sourceId, compounds, bulkMaps = null) {
    const cfg = SOURCE_CONFIG[sourceId];
    if (!cfg) throw new Error(`Unknown source: ${sourceId}`);

    let cursor = null;
    try { cursor = await readCursor(sourceId, CURSOR_PREFIX); }
    catch (err) { console.warn(`[BACKFILL/${sourceId}] Cursor read failed (${err.message}) - starting fresh`); }

    let eligible = compounds.filter(cfg.isEligible);
    if (eligible.length === 0) {
        console.log(`[BACKFILL/${sourceId}] Nothing eligible - all records already stamped or gate-fail.`);
        return { source: sourceId, processed: 0, stamped: 0, error: null, fetchErrors: 0 };
    }

    // PR-RXN-1g Fix A: bulk fast-path pre-pass before the per-record REST drain so
    // the RxNorm bulk Map reaches the cumulative backlog. Fail-soft (no maps ->
    // REST drain runs); re-filter so REST drains only the bulk-missed long tail.
    let bulkStamped = 0;
    if (cfg.bulkEnrichOne && bulkMaps) {
        for (const rec of eligible) cfg.bulkEnrichOne(rec, bulkMaps);
        const after = eligible.filter(cfg.isEligible);
        bulkStamped = eligible.length - after.length;
        console.log(`[BACKFILL/${sourceId}] bulk pre-pass: eligible_entering=${eligible.length} bulk_hits=${bulkStamped} rest_fallback=${after.length} bulk_map_unii_keys=${bulkMaps.uniiToRxcui?.size ?? 0}`);
        eligible = after;
        if (eligible.length === 0) {
            console.log(`[BACKFILL/${sourceId}] bulk pre-pass cleared all eligible - REST drain skipped.`);
            return { source: sourceId, processed: bulkStamped, stamped: bulkStamped, error: null, fetchErrors: 0 };
        }
    }

    // Forensic sample (1d audit): log first 10 eligible ids so operators can curl
    // the adapter to confirm a genuine null.
    const sample = eligible.slice(0, 10).map(r => ({
        id: r.id, inchi_key: r.inchi_key, unii: r.external_ids?.unii,
    }));
    console.log(`[BACKFILL/${sourceId}] Forensic sample (first 10 of ${eligible.length} eligible): ${JSON.stringify(sample)}`);

    const chunkSize = cursor?.chunk_size ?? DEFAULT_BACKFILL_CHUNK;

    // Lock 2: O(1) per-record isEligible flip detection. processedAttempts counts
    // enrichOne completions post-await only (= records finished, not dispatched; D8).
    let stampedThisRun = 0;
    let processedAttempts = 0;
    let errorMsg = null;
    const wrappedEnrichOne = async (record) => {
        const wasEligibleBefore = cfg.isEligible(record);
        await cfg.enrichOne(record);
        processedAttempts++;
        if (wasEligibleBefore && !cfg.isEligible(record)) stampedThisRun++;
    };

    // Snapshot cumulative fetch-errors BEFORE the drain (telemetry is module-
    // cumulative; the before/after diff below isolates this run).
    const errorsBefore = cfg.telemetry ? cfg.telemetry().faersErrorCount : 0;
    const sourceBudgetMs = cfg.drainBudgetMs ?? DRAIN_BUDGET_MS;

    let drain;
    try {
        drain = await drainAdapterBacklog({
            eligible, enrichOne: wrappedEnrichOne, chunkIterator, chunkSize,
            timeBudgetMs: sourceBudgetMs, coldStartEstimateMs: COLD_START_MS,
            sleepMsBetween: cfg.delayMs, initialCursor: cursor,
            logPrefix: `[BACKFILL/${sourceId}]`, logEveryNRecords: 200,
        });
    } catch (err) {
        errorMsg = err.message;
        console.error(`[BACKFILL/${sourceId}] Drain aborted mid-flight: ${err.message}`);
        return { source: sourceId, processed: processedAttempts, stamped: stampedThisRun + bulkStamped, error: errorMsg, fetchErrors: cfg.telemetry ? cfg.telemetry().faersErrorCount - errorsBefore : 0 };
    }

    // PR-FACTORY3-OPENFDA-KEY: per-run fetch-error delta de-masks a keyless failure
    // -- a FETCH-FAILURE run (openFDA null from a missing OPENFDA_API_KEY) flips the
    // verdict off saturation when errors exceed the ratio ([[cross_cycle_silent_data_loss]]).
    const fetchErrorsThisRun = cfg.telemetry ? cfg.telemetry().faersErrorCount - errorsBefore : 0;
    const fetchFailureDominant = cfg.telemetry
        && drain.processedInRun > 0
        && fetchErrorsThisRun > drain.processedInRun * FAERS_FETCH_FAILURE_RATIO;

    // Forensic verdict (1d audit): saturation vs silent failure vs fetch-failure.
    let verdict;
    if (fetchFailureDominant) {
        verdict = `FETCH_FAILURES (${fetchErrorsThisRun} errors / ${drain.processedInRun} processed -- NOT saturation; check OPENFDA_API_KEY) [stamped_this_run=${stampedThisRun}]`;
    } else if (stampedThisRun > 0) {
        verdict = `MONOTONIC_GROWTH (+${stampedThisRun} stamps this run -- API healthy, eligible pool draining)`;
    } else {
        verdict = `SATURATION_CONFIRMED (0 stamps + ${fetchErrorsThisRun} fetch-errors across ${drain.processedInRun} record attempts -- consistent with prior cycles history of API returning null for this eligible subset)`;
    }
    console.log(`[BACKFILL/${sourceId}] Drain done | terminatedBy=${drain.terminatedBy} | processedInRun=${drain.processedInRun} | stamped_this_run=${stampedThisRun} | fetch_errors_this_run=${fetchErrorsThisRun} | remainingBacklog=${drain.remainingBacklog} | verdict=${verdict}`);

    // D8: persist cursor after drain (terminal atomic commit per source).
    if (drain.finalCursorResult) {
        const nextCursor = buildNextCursor({
            source: sourceId, prev: cursor,
            chunkResult: drain.finalCursorResult,
            processedCount: drain.processedInRun,
            totalEligible: drain.finalCursorResult.totalEligible,
            chunkSize,
        });
        try {
            await writeCursor(sourceId, nextCursor, CURSOR_PREFIX);
            console.log(`[BACKFILL/${sourceId}] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
        } catch (err) {
            console.error(`[BACKFILL/${sourceId}] Cursor write failed - next cycle may re-do this slice: ${err.message}`);
        }
    } else {
        console.log(`[BACKFILL/${sourceId}] No chunks drained -- cursor unchanged`);
    }

    return { source: sourceId, processed: drain.processedInRun, stamped: stampedThisRun + bulkStamped, error: errorMsg, fetchErrors: fetchErrorsThisRun, fetchFailureDominant };
}

async function main() {
    console.log('[BACKFILL] V1 cycle 22 PR-CORE-3 - aggregated cumulative enrichment');

    const compounds = await loadJsonlStrict(COMPOUNDS_FILE);
    if (compounds.length === 0) {
        console.error(`[BACKFILL] FATAL: ${COMPOUNDS_FILE} empty - refusing to write back nothing.`);
        process.exit(1);
    }
    console.log(`[BACKFILL] Loaded cumulative ${compounds.length} compounds`);

    // PR-RXN-1g: load RxNorm bulk maps ONCE - shared by Fix A (bulk pre-pass) and
    // Fix B (DailyMed re-link). Fail-soft: null maps degrade to prior behavior.
    let bulkMaps = null;
    try { bulkMaps = await loadRxnormBulkMaps(); }
    catch (err) { console.warn(`[BACKFILL] RxNorm bulk maps unavailable (${err.message}) - Fix A + Fix B degrade to prior behavior`); }

    const summaries = [];
    let anySuccess = false;
    for (const sourceId of Object.keys(SOURCE_CONFIG)) {
        try {
            const r = await backfillOneSource(sourceId, compounds, bulkMaps);
            summaries.push(r);
            if (r.error == null) anySuccess = true;
        } catch (err) {
            console.error(`[BACKFILL] Unhandled error for source ${sourceId}: ${err.message}`);
            summaries.push({ source: sourceId, processed: 0, stamped: 0, error: err.message });
        }
    }

    // Only write back if at least one source succeeded; a total wipe (all errored)
    // is suspicious -- keep the prior merged cumulative intact for F3's upload.
    if (anySuccess) {
        // PR-RXN-1g Fix B re-link + PR-MD-1e harm telemetry + PR-MD-2a corpus add-list emit.
        const labels = await loadJsonlStrict(DRUG_LABELS_FILE);
        const rl = relinkCumulativeDailymed(compounds, labels, bulkMaps);
        console.log(formatDailymedRelinkLog(rl));
        await emitCorpusAddList(buildCorpusAddList(rl), { generatedFrom: process.env.GITHUB_RUN_ID ?? null });
        await writeJsonl(COMPOUNDS_FILE, compounds);
        console.log(`[BACKFILL] Wrote back ${compounds.length} compounds to ${COMPOUNDS_FILE}`);
    } else {
        console.error(`[BACKFILL] All sources errored - SKIPPING writeback to avoid clobbering merged cumulative.`);
    }
    console.log(`\n[BACKFILL] === Summary ===`);
    for (const s of summaries) {
        let tag = s.error ? `ERROR(${s.error.slice(0, 80)})` : 'OK';
        // Surface fetch-errors LOUDLY so keyless openFDA (0 stamps + N errors)
        // can never read as benign saturation here either.
        if (s.fetchFailureDominant) tag = `FETCH_FAILURES(${s.fetchErrors} errors -- check OPENFDA_API_KEY)`;
        const errTag = s.fetchErrors ? ` fetch_errors=${s.fetchErrors}` : '';
        console.log(`  ${s.source.padEnd(15)} processed=${s.processed} stamped=${s.stamped}${errTag} ${tag}`);
    }

    // Exit nonzero on any per-source failure so stage-3's wrapper logs the
    // degraded outcome -- but per D7 stage-3 treats this as non-fatal and
    // continues. The bundle is already written (when anySuccess) so upload proceeds.
    const anyError = summaries.some(s => s.error != null);
    process.exit(anyError ? 1 : 0);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[BACKFILL] Fatal:', err); process.exit(2); });
}
