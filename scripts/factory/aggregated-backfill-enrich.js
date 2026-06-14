/**
 * Aggregated Cumulative Backfill Enricher V1 (cycle 22 PR-CORE-3).
 *
 * Runs INSIDE stage-3-aggregate.js, AFTER the cumulative merge + BEFORE the
 * indices. Walks the cumulative backlog via the SAME enrichOne + skip-if-stamped
 * predicates in cursor namespace state/aggregated-cursor/<source>.json (full
 * O(N/chunk) coverage; per-source failures logged, never abort). PR-RXN-1g adds
 * RxNorm bulk pre-pass + DailyMed re-link. PR-FACTORY3-OPENFDA-KEY: per-source
 * FAERS budget + FETCH_FAILURES-vs-SATURATION de-mask. P-8 GAP-B: optional HARD
 * per-run FAERS record cap (FAERS_BACKFILL_MAX_RECORDS) + stop_reason evidence.
 */

import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { readCursor, writeCursor, chunkIterator, buildNextCursor } from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS, STOP_REASON, buildDrainEvidence, parseMaxRecordsEnv } from './lib/drain-adapter-backlog.js';
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
// re-enrich (~40k eligible) -- drains faster without extending the shared 25min
// unichem/rxnorm budget. Env: FAERS_BACKFILL_BUDGET_MS.
const FAERS_DRAIN_BUDGET_MS = Number(process.env.FAERS_BACKFILL_BUDGET_MS) || 60 * 60 * 1000;
// FETCH-FAILURE (not saturation) when a run's openFDA error count exceeds this
// fraction of records attempted (keyless ~=1.0; healthy ~=0). Env override too.
const FAERS_FETCH_FAILURE_RATIO = Number(process.env.FAERS_FETCH_FAILURE_RATIO) || 0.25;
// P-8 GAP-B: HARD per-run FAERS record cap. UNSET = no cap = today's behavior;
// a finite value (P-8R1 bound 8000) caps the drain at exactly N records.
const FAERS_BACKFILL_MAX_RECORDS = parseMaxRecordsEnv('FAERS_BACKFILL_MAX_RECORDS');

// Per-source rate limits matching the underlying adapters. drainBudgetMs (opt):
// overrides the shared DRAIN_BUDGET_MS. telemetry (opt): returns cumulative
// { faersErrorCount, ... }; the drain snapshots a per-run delta to de-mask
// keyless saturation ([[cross_cycle_silent_data_loss]]).
const SOURCE_CONFIG = Object.freeze({
    unichem:       { delayMs: 250, enrichOne: enrichOneUnichem, isEligible: isEligibleUnichem },
    rxnorm:        { delayMs: 150, enrichOne: enrichOneRxnorm,  isEligible: isEligibleRxnorm, bulkEnrichOne: bulkEnrichOneRxnorm },
    openfda_faers: { delayMs: 250, enrichOne: enrichOneFaers,   isEligible: isEligibleFaers, drainBudgetMs: FAERS_DRAIN_BUDGET_MS, telemetry: faersTelemetry, maxRecords: FAERS_BACKFILL_MAX_RECORDS },
});

// Streaming JSONL writer (per-record write, conditional drain await).
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

// Run one source's backfill on the in-memory compounds list via V5
// drainAdapterBacklog. Returns { source, processed, stamped, error, fetchErrors,
// evidence }. Mutates compounds in place (drain scopes runStart per-call).
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

    // PR-RXN-1g Fix A: bulk fast-path pre-pass before the per-record REST drain
    // (fail-soft: no maps -> REST drain runs; re-filter to the bulk-missed tail).
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

    // Forensic sample (1d audit): first 10 eligible ids so operators can curl the adapter.
    const sample = eligible.slice(0, 10).map(r => ({
        id: r.id, inchi_key: r.inchi_key, unii: r.external_ids?.unii,
    }));
    console.log(`[BACKFILL/${sourceId}] Forensic sample (first 10 of ${eligible.length} eligible): ${JSON.stringify(sample)}`);

    const chunkSize = cursor?.chunk_size ?? DEFAULT_BACKFILL_CHUNK;
    // Lock 2: O(1) per-record isEligible flip detection. processedAttempts counts
    // enrichOne completions post-await only (records finished, not dispatched; D8).
    let stampedThisRun = 0;
    let processedAttempts = 0;
    let errorMsg = null;
    const wrappedEnrichOne = async (record) => {
        const wasEligibleBefore = cfg.isEligible(record);
        await cfg.enrichOne(record);
        processedAttempts++;
        if (wasEligibleBefore && !cfg.isEligible(record)) stampedThisRun++;
    };

    // Snapshot cumulative fetch-errors BEFORE the drain (before/after diff isolates this run).
    const errorsBefore = cfg.telemetry ? cfg.telemetry().faersErrorCount : 0;
    const sourceBudgetMs = cfg.drainBudgetMs ?? DRAIN_BUDGET_MS;
    const cursorBefore = cursor?.cursor_id ?? null; // P-8 GAP-B evidence
    const requestedMaxRecords = cfg.maxRecords ?? null; // P-8 GAP-B record cap

    let drain;
    try {
        drain = await drainAdapterBacklog({
            eligible, enrichOne: wrappedEnrichOne, chunkIterator, chunkSize,
            timeBudgetMs: sourceBudgetMs, coldStartEstimateMs: COLD_START_MS,
            sleepMsBetween: cfg.delayMs, initialCursor: cursor,
            logPrefix: `[BACKFILL/${sourceId}]`, logEveryNRecords: 200,
            maxRecords: requestedMaxRecords,
        });
    } catch (err) {
        errorMsg = err.message;
        console.error(`[BACKFILL/${sourceId}] Drain aborted mid-flight: ${err.message}`);
        // P-8 GAP-B: in-drain throw is SOURCE/INVARIANT failure (INVARIANT explicit in msg).
        const stopReason = /INVARIANT_FAILURE/.test(err.message)
            ? STOP_REASON.INVARIANT_FAILURE : STOP_REASON.SOURCE_FAILURE;
        return {
            source: sourceId, processed: processedAttempts, stamped: stampedThisRun + bulkStamped,
            error: errorMsg, fetchErrors: cfg.telemetry ? cfg.telemetry().faersErrorCount - errorsBefore : 0,
            evidence: buildDrainEvidence({
                requestedMaxRecords, stampedThisRun, attemptedThisRun: processedAttempts,
                remainingBacklog: null, stopReason, cursorBefore, cursorAfter: cursorBefore,
            }),
        };
    }

    // PR-FACTORY3-OPENFDA-KEY: per-run fetch-error delta de-masks a keyless failure
    // -- flips the verdict off saturation when errors exceed the ratio.
    const fetchErrorsThisRun = cfg.telemetry ? cfg.telemetry().faersErrorCount - errorsBefore : 0;
    const fetchFailureDominant = cfg.telemetry
        && drain.processedInRun > 0
        && fetchErrorsThisRun > drain.processedInRun * FAERS_FETCH_FAILURE_RATIO;

    // Forensic verdict (1d audit): saturation vs silent failure vs fetch-failure.
    let verdict;
    if (fetchFailureDominant) verdict = `FETCH_FAILURES (${fetchErrorsThisRun} errors / ${drain.processedInRun} processed -- NOT saturation; check OPENFDA_API_KEY) [stamped_this_run=${stampedThisRun}]`;
    else if (stampedThisRun > 0) verdict = `MONOTONIC_GROWTH (+${stampedThisRun} stamps this run -- API healthy, eligible pool draining)`;
    else verdict = `SATURATION_CONFIRMED (0 stamps + ${fetchErrorsThisRun} fetch-errors across ${drain.processedInRun} record attempts -- API returning null for this eligible subset)`;
    console.log(`[BACKFILL/${sourceId}] Drain done | terminatedBy=${drain.terminatedBy} | processedInRun=${drain.processedInRun} | stamped_this_run=${stampedThisRun} | fetch_errors_this_run=${fetchErrorsThisRun} | remainingBacklog=${drain.remainingBacklog} | verdict=${verdict}`);

    // D8: persist cursor after drain (terminal atomic commit per source).
    if (drain.finalCursorResult) {
        const nextCursor = buildNextCursor({
            source: sourceId, prev: cursor, chunkResult: drain.finalCursorResult,
            processedCount: drain.processedInRun,
            totalEligible: drain.finalCursorResult.totalEligible, chunkSize,
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

    // P-8 GAP-B: evidence block. cursor_after only READS the drain's resulting id
    // (the cursor ALGORITHM is unchanged); stop_reason comes from the drain.
    const evidence = buildDrainEvidence({
        requestedMaxRecords, stampedThisRun: stampedThisRun + bulkStamped,
        attemptedThisRun: processedAttempts, remainingBacklog: drain.remainingBacklog,
        stopReason: drain.stopReason ?? STOP_REASON.BACKLOG_EXHAUSTED,
        cursorBefore, cursorAfter: drain.finalCursor?.cursor_id ?? cursorBefore,
    });
    console.log(`[BACKFILL/${sourceId}] P-8 evidence: ${JSON.stringify(evidence)}`);

    return { source: sourceId, processed: drain.processedInRun, stamped: stampedThisRun + bulkStamped, error: errorMsg, fetchErrors: fetchErrorsThisRun, fetchFailureDominant, evidence };
}

async function main() {
    console.log('[BACKFILL] V1 cycle 22 PR-CORE-3 - aggregated cumulative enrichment');

    const compounds = await loadJsonlStrict(COMPOUNDS_FILE);
    if (compounds.length === 0) {
        console.error(`[BACKFILL] FATAL: ${COMPOUNDS_FILE} empty - refusing to write back nothing.`);
        process.exit(1);
    }
    console.log(`[BACKFILL] Loaded cumulative ${compounds.length} compounds`);

    // PR-RXN-1g: load RxNorm bulk maps ONCE (shared by Fix A + Fix B; fail-soft).
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

    // Only write back if at least one source succeeded (a total wipe is suspicious).
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
        // Surface fetch-errors LOUDLY so keyless openFDA never reads as benign saturation.
        if (s.fetchFailureDominant) tag = `FETCH_FAILURES(${s.fetchErrors} errors -- check OPENFDA_API_KEY)`;
        const errTag = s.fetchErrors ? ` fetch_errors=${s.fetchErrors}` : '';
        console.log(`  ${s.source.padEnd(15)} processed=${s.processed} stamped=${s.stamped}${errTag} ${tag}`);
    }

    // Exit nonzero on any per-source failure (stage-3 treats it non-fatal per D7).
    const anyError = summaries.some(s => s.error != null);
    process.exit(anyError ? 1 : 0);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[BACKFILL] Fatal:', err); process.exit(2); });
}
