/**
 * Compound FAERS Enricher V0.5 (cycle 22 PR-CORE-2) — quantified safety signals.
 *
 * openFDA `count=patient.reaction.reactionmeddrapt.exact` returns top ADR
 * terms with FAERS report counts in a single API call keyed by UNII.
 * Result: each UNII-bearing compound gains `fda_signals.faers_top_adr_terms`
 * and `faers_total_top_count` (NegEvidence Cat E signal-level).
 *
 * V0.5 (PR-CORE-2): cursor + skip-if-stamped. Eligibility:
 *   - external_ids.unii present (gate)
 *   - fda_signals.faers_top_adr_terms not yet populated (skip)
 * Cursor at R2 state/enrichment-cursor/openfda_faers.json. Default
 * chunk_size 5000 — at 250ms/record yields ~21 min/cycle, within stage-2
 * 350-min budget. PR-CORE-1 baseline 2026-05-23 showed only 2.36%
 * gate-adjusted coverage because the old non-cursored loop walltime-
 * exhausted after the array prefix.
 *
 * Pipeline position: runs after fda-enricher (which produces fda_signals
 * baseline) and compound-id-resolver (which populates UNII).
 */

import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { fetchFaersSignalsByUnii, REQUEST_DELAY_MS } from '../ingestion/adapters/openfda-adapter.js';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor, DEFAULT_CHUNK_SIZE,
} from './lib/enrichment-cursor.js';
import { drainAdapterBacklog, DEFAULT_CHUNK_DURATION_ESTIMATE_MS } from './lib/drain-adapter-backlog.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const SOURCE = 'openfda_faers';
const DATA_DIR = './output/linked';
const DRAIN_BUDGET_MS = Number(process.env.ADAPTER_DRAIN_BUDGET_MS) || 25 * 60 * 1000;
const COLD_START_MS = Number(process.env.ADAPTER_DRAIN_COLD_START_MS) || DEFAULT_CHUNK_DURATION_ESTIMATE_MS;
const FAERS_LIMIT = 30;            // KEEP 30 in 5b (uncap = 5c, atomic w/ schema lift).
const MAX_FAERS_ATTEMPTS = 3;      // poison-UNII bound (part 4): terminal after N failures.

// LOUD per-run telemetry (part 3 + 6). faers_error_count is cumulative;
// faersFailuresByMinute keys wall-minute -> count so the run can report a
// per-minute 429/failure RATE, not just a total (a burst is the real signal).
let faersErrorCount = 0;
let faersTerminalFailed = 0;
const faersFailuresByMinute = new Map();

function recordFaersFailure() {
    faersErrorCount += 1;
    const minute = Math.floor(Date.now() / 60000);
    faersFailuresByMinute.set(minute, (faersFailuresByMinute.get(minute) ?? 0) + 1);
}

export function faersTelemetry() {
    let peakPerMin = 0;
    for (const v of faersFailuresByMinute.values()) peakPerMin = Math.max(peakPerMin, v);
    return { faersErrorCount, faersTerminalFailed, peakFailuresPerMinute: peakPerMin };
}

// Streaming JSONL writer (V5 architect-locked V8-thread defense).
async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

// Skip-if-stamped: a compound is FAERS-enriched (LEAVES the eligible set) once
// fda_signals.faers_top_adr_terms is an ARRAY -- written ONLY on a GENUINE
// outcome: success, genuine-empty ([], "queried, no signals"), or a TERMINAL
// poison-record failure (part 4 stamps [] + faers_failed:true after N attempts).
// A FETCH FAILURE leaves the array UNWRITTEN (undefined) so the record stays
// eligible and is requeried next cron -- bounded to N by the attempt counter.
// No body change needed for the contract: Array.isArray(undefined)=false stays
// eligible; Array.isArray([])=true completes.
export function isEligible(record) {
    if (!record?.external_ids?.unii) return false;
    const terms = record?.fda_signals?.faers_top_adr_terms;
    if (Array.isArray(terms)) return false; // already attempted/terminal
    return true;
}

// enrichOne MUST NEVER THROW (part 4): a thrown error from a poison UNII would
// abort the whole stage every cron (the drain loop has no per-record guard of
// its own historically). Any unexpected throw is caught here, counted as a
// fetch failure, and folded into the attempt-counter path. Returns the record.
export async function enrichOne(record) {
    const unii = record.external_ids?.unii;
    if (!unii) return record;
    record.fda_signals = record.fda_signals ?? { sources: [] };

    let result = null;
    try {
        result = await fetchFaersSignalsByUnii(unii, FAERS_LIMIT);
    } catch (err) {
        // Belt-and-suspenders: the adapter already converts failures to a null
        // sentinel, but guarantee no throw escapes regardless.
        result = null;
    }

    if (result === null) {
        // FETCH FAILURE: do NOT stamp faers_top_adr_terms (stays eligible).
        recordFaersFailure();
        const attempts = (record.fda_signals.faers_attempts ?? 0) + 1;
        record.fda_signals.faers_attempts = attempts;
        if (attempts >= MAX_FAERS_ATTEMPTS) {
            // TERMINAL poison-record marker (part 4): stamp [] so isEligible
            // returns false (record LEAVES the eligible set, stops starving
            // never-queried compounds) but faers_failed:true keeps it
            // DISTINGUISHABLE from a genuine-empty in telemetry.
            faersTerminalFailed += 1;
            record.fda_signals.faers_failed = true;
            record.fda_signals.faers_top_adr_terms = [];
            record.fda_signals.faers_total_top_count = 0;
            record.fda_signals.faers_queried_at = new Date().toISOString();
        }
        return record;
    }

    // SUCCESS / GENUINE-EMPTY: stamp the array (possibly empty) -> completes.
    const terms = result.terms.slice(0, FAERS_LIMIT);
    record.fda_signals.faers_top_adr_terms = terms;
    record.fda_signals.faers_total_top_count = terms.reduce((s, r) => s + r.count, 0);
    record.fda_signals.faers_queried_at = new Date().toISOString();
    // Saturation flag (part 5): the count is a TOP-N slice, not the full set.
    // KEEP limit=30 here; the uncap is 5c (atomic with the schema cap lift).
    if (result.truncated) record.fda_signals.faers_truncated = true;
    if (!Array.isArray(record.fda_signals.sources)) record.fda_signals.sources = [];
    if (terms.length > 0 && !record.fda_signals.sources.includes('openfda_faers')) {
        record.fda_signals.sources.push('openfda_faers');
    }
    return record;
}

async function main() {
    console.log('[FAERS-ENRICHER] V0.5 - cycle 22 PR-CORE-2 cursor-driven');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonlStrict(file);
    console.log(`[FAERS-ENRICHER] Loaded ${compounds.length} compounds`);

    const eligible = compounds.filter(isEligible);
    console.log(`[FAERS-ENRICHER] Eligible (UNII present, FAERS not yet stamped): ${eligible.length}`);

    if (eligible.length === 0) {
        console.log('[FAERS-ENRICHER] Nothing to do this cycle.');
        return;
    }

    let cursor = null;
    try { cursor = await readCursor(SOURCE); }
    catch (err) { console.warn(`[FAERS-ENRICHER] Cursor read failed (${err.message}) - starting fresh`); }
    const chunkSize = cursor?.chunk_size ?? DEFAULT_CHUNK_SIZE;
    console.log(`[FAERS-ENRICHER] Cursor: prev=${cursor?.cursor_id ?? '(none)'} | chunk_size=${chunkSize} | budget=${(DRAIN_BUDGET_MS / 60000).toFixed(1)}min | coldStart=${(COLD_START_MS / 60000).toFixed(1)}min`);

    // V5 drain-until-cleared: EWMA gate especially relevant for FAERS because
    // openFDA 429 backoff creates long-tail p99 latency spikes; recency-
    // weighted predictor will tighten budget projection within 1-2 chunks
    // if rate limit kicks in.
    const drain = await drainAdapterBacklog({
        eligible, enrichOne, chunkIterator, chunkSize,
        timeBudgetMs: DRAIN_BUDGET_MS, coldStartEstimateMs: COLD_START_MS,
        sleepMsBetween: REQUEST_DELAY_MS, initialCursor: cursor,
        logPrefix: '[FAERS-ENRICHER]', logEveryNRecords: 100,
    });
    console.log(`[FAERS-ENRICHER] Drain done | terminatedBy=${drain.terminatedBy} | chunksDrained=${drain.chunksDrained} | processedInRun=${drain.processedInRun} | remainingBacklog=${drain.remainingBacklog}`);

    let withFaersData = 0;
    let totalReports = 0;
    for (const rec of compounds) {
        if (rec.fda_signals?.faers_top_adr_terms?.length > 0) {
            withFaersData++;
            totalReports += rec.fda_signals.faers_total_top_count ?? 0;
        }
    }

    // Terminal atomic commit.
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
            console.log(`[FAERS-ENRICHER] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
        } catch (err) {
            console.error(`[FAERS-ENRICHER] Cursor write failed: ${err.message}`);
            throw err;
        }
    } else {
        console.log('[FAERS-ENRICHER] No chunks drained (empty eligible at entry) -- cursor unchanged');
    }

    const tel = faersTelemetry();
    console.log(`\n[FAERS-ENRICHER] Complete - cumulative with FAERS: ${withFaersData}/${compounds.length} | ${totalReports.toLocaleString()} reports`);
    console.log(`[FAERS-ENRICHER] Fetch-failure telemetry: errors=${tel.faersErrorCount} | terminal_failed(N>=${MAX_FAERS_ATTEMPTS})=${tel.faersTerminalFailed} | peak_failures_per_minute=${tel.peakFailuresPerMinute}`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error('[FAERS-ENRICHER] Fatal:', err); process.exit(1); });
}
