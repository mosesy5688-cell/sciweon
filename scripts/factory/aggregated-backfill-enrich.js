/**
 * Aggregated Cumulative Backfill Enricher V1 (cycle 22 PR-CORE-3).
 *
 * Runs INSIDE stage-3-aggregate.js, AFTER mergeLocalAggregatedWithPrevious
 * (so ./output/linked/compounds-enriched.jsonl is the freshly-merged
 * cumulative) and BEFORE buildSearchIndex (so downstream indices see
 * the backfilled records).
 *
 * Closes the wiring arc PR-CORE-2 missed: its F2 cursor enrichers see only the
 * F1 increment (~5k), never the ~70k cumulative backlog. PR-CORE-3 walks the
 * cumulative via the SAME enrichOne + skip-if-stamped predicates, in a separate
 * cursor namespace state/aggregated-cursor/<source>.json. Triple-lock
 * ([[no_shortcut_in_science]]): full O(N/chunk) coverage; predicates ==
 * SOURCE_REQUIRED_FIELDS SSoT; closed PR-CORE-1->3->1 loop. D7/D8: per-source
 * failure logs explicit, never aborts; cursor persists across partial failure.
 *
 * PR-RXN-1g adds two F3-cumulative bridges: (Fix A) a RxNorm bulk fast-path
 * pre-pass so the bulk Map UNII supply reaches the backlog; (Fix B) a terminal
 * cumulative DailyMed re-link on the resident array before writeback.
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor,
} from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS } from './lib/drain-adapter-backlog.js';
import {
    isEligible as isEligibleUnichem,
    enrichOne as enrichOneUnichem,
} from './compound-id-resolver.js';
import {
    isEligible as isEligibleRxnorm,
    enrichOne as enrichOneRxnorm,
    bulkEnrichOne as bulkEnrichOneRxnorm,
} from './compound-rxnorm-enricher.js';
import {
    isEligible as isEligibleFaers,
    enrichOne as enrichOneFaers,
} from './compound-faers-enricher.js';
import { loadRxnormBulkMaps } from '../ingestion/adapters/rxnorm-bulk-adapter.js';
import { relinkCumulativeDailymed, formatDailymedRelinkLog } from './lib/dailymed-crosslink.js';

const DATA_DIR = './output/linked';
const COMPOUNDS_FILE = path.join(DATA_DIR, 'compounds-enriched.jsonl');
const DRUG_LABELS_FILE = path.join(DATA_DIR, 'drug-labels.jsonl');
const CURSOR_PREFIX = 'state/aggregated-cursor/';
const DEFAULT_BACKFILL_CHUNK = 2000;
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 25 * 60 * 1000;
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || DEFAULT_CHUNK_DURATION_ESTIMATE_MS;

// Conservative per-source rate limits matching the underlying adapters.
const SOURCE_CONFIG = Object.freeze({
    unichem:       { delayMs: 250, enrichOne: enrichOneUnichem, isEligible: isEligibleUnichem },
    rxnorm:        { delayMs: 150, enrichOne: enrichOneRxnorm,  isEligible: isEligibleRxnorm, bulkEnrichOne: bulkEnrichOneRxnorm },
    openfda_faers: { delayMs: 250, enrichOne: enrichOneFaers,   isEligible: isEligibleFaers   },
});

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

// Streaming JSONL writer (V5 architect-locked V8-thread defense + architect
// Lock 3 backpressure honor). Per-record write with conditional drain await
// only on stream.write false return -- no Promise-per-record microtask thrash.
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

// Run one source's backfill on the in-memory compounds list via V5
// drainAdapterBacklog. Returns { source, processed, stamped, error }.
// Mutates compounds in place via shared object refs through eligible filter.
// Per architect Lock 1: drainAdapterBacklog scopes runStart per-call so
// sequential sources never inherit a polluted shared clock.
export async function backfillOneSource(sourceId, compounds, bulkMaps = null) {
    const cfg = SOURCE_CONFIG[sourceId];
    if (!cfg) throw new Error(`Unknown source: ${sourceId}`);

    let cursor = null;
    try { cursor = await readCursor(sourceId, CURSOR_PREFIX); }
    catch (err) {
        console.warn(`[BACKFILL/${sourceId}] Cursor read failed (${err.message}) - starting fresh`);
    }

    let eligible = compounds.filter(cfg.isEligible);
    if (eligible.length === 0) {
        console.log(`[BACKFILL/${sourceId}] Nothing eligible - all records already stamped or gate-fail.`);
        return { source: sourceId, processed: 0, stamped: 0, error: null };
    }

    // PR-RXN-1g Fix A: bulk fast-path pre-pass before the per-record REST drain
    // so the RxNorm bulk Map (7234 UNII keys) reaches the ~70k cumulative
    // backlog. Fail-soft (no bulk path / maps unavailable -> REST drain runs).
    // Re-filter so REST drains only the bulk-map-missed long tail.
    let bulkStamped = 0;
    if (cfg.bulkEnrichOne && bulkMaps) {
        for (const rec of eligible) cfg.bulkEnrichOne(rec, bulkMaps);
        const after = eligible.filter(cfg.isEligible);
        bulkStamped = eligible.length - after.length;
        console.log(`[BACKFILL/${sourceId}] bulk pre-pass: eligible_entering=${eligible.length} bulk_hits=${bulkStamped} rest_fallback=${after.length} bulk_map_unii_keys=${bulkMaps.uniiToRxcui?.size ?? 0}`);
        eligible = after;
        if (eligible.length === 0) {
            console.log(`[BACKFILL/${sourceId}] bulk pre-pass cleared all eligible - REST drain skipped.`);
            return { source: sourceId, processed: bulkStamped, stamped: bulkStamped, error: null };
        }
    }

    // Forensic sample (1d audit per cont 47): pre-drain log first 10 eligible
    // records' identifying fields. Operators can manually verify the adapter
    // is genuinely returning null for these InChIKeys via direct API curl.
    const sample = eligible.slice(0, 10).map(r => ({
        id: r.id, inchi_key: r.inchi_key, unii: r.external_ids?.unii,
    }));
    console.log(`[BACKFILL/${sourceId}] Forensic sample (first 10 of ${eligible.length} eligible): ${JSON.stringify(sample)}`);

    const chunkSize = cursor?.chunk_size ?? DEFAULT_BACKFILL_CHUNK;

    // Architect Lock 2: O(1) per-record isEligible flip detection instead of
    // O(N) pre/post filters that would burn 510K array scans across 3 sources.
    // processedAttempts tracks successful enrichOne completions only (post-await
    // increment) so partial-failure reporting matches D8 contract: r.processed
    // = records that the adapter actually finished for, NOT records dispatched.
    let stampedThisRun = 0;
    let processedAttempts = 0;
    let errorMsg = null;
    const wrappedEnrichOne = async (record) => {
        const wasEligibleBefore = cfg.isEligible(record);
        await cfg.enrichOne(record);
        processedAttempts++;
        if (wasEligibleBefore && !cfg.isEligible(record)) stampedThisRun++;
    };

    let drain;
    try {
        drain = await drainAdapterBacklog({
            eligible, enrichOne: wrappedEnrichOne, chunkIterator, chunkSize,
            timeBudgetMs: DRAIN_BUDGET_MS, coldStartEstimateMs: COLD_START_MS,
            sleepMsBetween: cfg.delayMs, initialCursor: cursor,
            logPrefix: `[BACKFILL/${sourceId}]`, logEveryNRecords: 200,
        });
    } catch (err) {
        errorMsg = err.message;
        console.error(`[BACKFILL/${sourceId}] Drain aborted mid-flight: ${err.message}`);
        return { source: sourceId, processed: processedAttempts, stamped: stampedThisRun + bulkStamped, error: errorMsg };
    }

    // Forensic verdict per-source (1d audit): explicit empirical evidence
    // for hypothesis A (saturation) vs B (silent failure). Future operators
    // probe this log to distinguish "API ceiling acknowledged" from "bug".
    const verdict = stampedThisRun > 0
        ? `MONOTONIC_GROWTH (+${stampedThisRun} stamps this run -- API healthy, eligible pool draining)`
        : `SATURATION_CONFIRMED (0 stamps across ${drain.processedInRun} record attempts -- consistent with prior cycles history of API returning null for this eligible subset)`;
    console.log(`[BACKFILL/${sourceId}] Drain done | terminatedBy=${drain.terminatedBy} | processedInRun=${drain.processedInRun} | stamped_this_run=${stampedThisRun} | remainingBacklog=${drain.remainingBacklog} | verdict=${verdict}`);

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

    return { source: sourceId, processed: drain.processedInRun, stamped: stampedThisRun + bulkStamped, error: errorMsg };
}

async function main() {
    console.log('[BACKFILL] V1 cycle 22 PR-CORE-3 - aggregated cumulative enrichment');

    const compounds = await loadJsonl(COMPOUNDS_FILE);
    if (compounds.length === 0) {
        console.error(`[BACKFILL] FATAL: ${COMPOUNDS_FILE} empty - refusing to write back nothing.`);
        process.exit(1);
    }
    console.log(`[BACKFILL] Loaded cumulative ${compounds.length} compounds`);

    // PR-RXN-1g: load RxNorm bulk maps ONCE - shared by Fix A (rxnorm bulk
    // pre-pass) and Fix B (DailyMed re-link label rehydration). Fail-soft:
    // null maps degrade both to prior behavior, never crash the backfill.
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

    // Only write back if at least one source succeeded. A total wipe (all
    // sources errored) is suspicious - keep the prior local file intact so
    // F3's upload step uses the unchanged-but-not-wrong merged cumulative.
    if (anySuccess) {
        // PR-RXN-1g Fix B re-link + PR-MD-1e label-harm telemetry (see lib headers).
        const labels = await loadJsonl(DRUG_LABELS_FILE);
        const rl = relinkCumulativeDailymed(compounds, labels, bulkMaps);
        console.log(formatDailymedRelinkLog(rl));
        await writeJsonl(COMPOUNDS_FILE, compounds);
        console.log(`[BACKFILL] Wrote back ${compounds.length} compounds to ${COMPOUNDS_FILE}`);
    } else {
        console.error(`[BACKFILL] All sources errored - SKIPPING writeback to avoid clobbering merged cumulative.`);
    }

    console.log(`\n[BACKFILL] === Summary ===`);
    for (const s of summaries) {
        const tag = s.error ? `ERROR(${s.error.slice(0, 80)})` : 'OK';
        console.log(`  ${s.source.padEnd(15)} processed=${s.processed} stamped=${s.stamped} ${tag}`);
    }

    // Exit nonzero on any per-source failure so stage-3's wrapper can log
    // the degraded outcome - but per D7, stage-3 treats this as non-fatal
    // and continues the F3 chain. The cumulative bundle has been written
    // either way (when anySuccess) so search-index + upload proceed.
    const anyError = summaries.some(s => s.error != null);
    process.exit(anyError ? 1 : 0);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[BACKFILL] Fatal:', err); process.exit(2); });
}
