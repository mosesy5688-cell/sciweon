/**
 * Aggregated Cumulative Backfill Enricher V1 (cycle 22 PR-CORE-3).
 *
 * Runs INSIDE stage-3-aggregate.js, AFTER mergeLocalAggregatedWithPrevious
 * (so ./output/linked/compounds-enriched.jsonl is the freshly-merged
 * cumulative) and BEFORE buildSearchIndex (so downstream indices see
 * the backfilled records).
 *
 * Closes the wiring arc that PR-CORE-2 missed: PR-CORE-2's cursor
 * enrichers operate on the F1 increment in F2 (4999 records), never
 * touching the ~70k cumulative backlog. PR-CORE-3 walks the cumulative
 * via the SAME enricher.enrichOne functions + skip-if-stamped predicates,
 * with a separate cursor namespace at state/aggregated-cursor/<source>.json.
 *
 * Triple-lock anchor (per [[no_shortcut_in_science]]):
 *   - scale: lex-sorted cursor advances every cycle; full coverage in
 *     O(N/chunk_size). Conservative chunk_size 2000 (~21 min total
 *     walltime added to F3's 350-min budget).
 *   - quality: skip-if-stamped predicates are byte-identical to
 *     SOURCE_REQUIRED_FIELDS SSoT - no drift between PR-CORE-1 audit
 *     and PR-CORE-3 remediation.
 *   - relational structure: forms the PR-CORE-1 -> PR-CORE-3 -> PR-CORE-1
 *     closed feedback loop (audit drives backfill drives next audit).
 *
 * Failure containment (D7): per-source failure logs explicit, does NOT
 * abort the script. Cursor is written before exit even on partial-chunk
 * failure (D8) so the next cycle does not re-attempt the same records.
 */

import fs from 'fs/promises';
import path from 'path';
import {
    readCursor, writeCursor, chunkIterator, buildNextCursor,
} from './lib/enrichment-cursor.js';
import {
    isEligible as isEligibleUnichem,
    enrichOne as enrichOneUnichem,
} from './compound-id-resolver.js';
import {
    isEligible as isEligibleRxnorm,
    enrichOne as enrichOneRxnorm,
} from './compound-rxnorm-enricher.js';
import {
    isEligible as isEligibleFaers,
    enrichOne as enrichOneFaers,
} from './compound-faers-enricher.js';

const DATA_DIR = './output/linked';
const COMPOUNDS_FILE = path.join(DATA_DIR, 'compounds-enriched.jsonl');
const CURSOR_PREFIX = 'state/aggregated-cursor/';
const DEFAULT_BACKFILL_CHUNK = 2000;

// Conservative per-source rate limits matching the underlying adapters.
const SOURCE_CONFIG = Object.freeze({
    unichem:       { delayMs: 250, enrichOne: enrichOneUnichem, isEligible: isEligibleUnichem },
    rxnorm:        { delayMs: 150, enrichOne: enrichOneRxnorm,  isEligible: isEligibleRxnorm  },
    openfda_faers: { delayMs: 250, enrichOne: enrichOneFaers,   isEligible: isEligibleFaers   },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

// Run one source's backfill chunk on the in-memory compounds list.
// Returns { source, processed, stamped, error }.
// Mutates compounds in place. Writes cursor JSON before returning, even
// on partial failure mid-chunk - per D8 we MUST NOT lose cursor progress.
export async function backfillOneSource(sourceId, compounds) {
    const cfg = SOURCE_CONFIG[sourceId];
    if (!cfg) throw new Error(`Unknown source: ${sourceId}`);

    let cursor = null;
    try { cursor = await readCursor(sourceId, CURSOR_PREFIX); }
    catch (err) {
        console.warn(`[BACKFILL/${sourceId}] Cursor read failed (${err.message}) - starting fresh`);
    }

    const chunkSize = cursor?.chunk_size ?? DEFAULT_BACKFILL_CHUNK;
    const eligible = compounds.filter(cfg.isEligible);
    if (eligible.length === 0) {
        console.log(`[BACKFILL/${sourceId}] Nothing eligible - all records already stamped or gate-fail.`);
        return { source: sourceId, processed: 0, stamped: 0, error: null };
    }

    const { slice, nextCursorId, wrapped, totalEligible } = chunkIterator(eligible, cursor, chunkSize);
    console.log(`[BACKFILL/${sourceId}] eligible=${eligible.length} | chunk_size=${chunkSize} | slice=${slice.length} | wrapped=${wrapped}`);

    let processed = 0;
    let stamped = 0;
    let errorMsg = null;
    try {
        for (const rec of slice) {
            await cfg.enrichOne(rec);
            // Heuristic post-enrichment check using the same predicate that
            // PR-CORE-1 measures: a record is now considered stamped if
            // isEligible() returns false (i.e. it left the eligible set).
            if (!cfg.isEligible(rec)) stamped++;
            processed++;
            if (processed % 200 === 0 || processed === slice.length) {
                console.log(`[BACKFILL/${sourceId}] ${processed}/${slice.length} | stamped: ${stamped}`);
            }
            await sleep(cfg.delayMs);
        }
    } catch (err) {
        errorMsg = err.message;
        console.error(`[BACKFILL/${sourceId}] Chunk aborted mid-flight at ${processed}/${slice.length}: ${err.message}`);
    }

    // D8: persist cursor regardless of partial failure. nextCursorId is the
    // lex-greatest id of the *attempted* slice, so re-runs skip past the
    // attempted (even-if-failed) records and make forward progress.
    const nextCursor = buildNextCursor({
        source: sourceId, prev: cursor,
        chunkResult: { slice, nextCursorId, wrapped, totalEligible },
        processedCount: processed,
        totalEligible,
    });
    try {
        await writeCursor(sourceId, nextCursor, CURSOR_PREFIX);
        console.log(`[BACKFILL/${sourceId}] Cursor advanced -> ${nextCursor.cursor_id} | cycles_completed=${nextCursor.cycles_completed}`);
    } catch (err) {
        // Cursor-write failure is its own diagnostic; log but don't escalate
        // (the in-memory enriched records are still about to be uploaded by
        // F3, which is the more important guarantee). Next cycle will re-do
        // the same slice if cursor missing, which is wasteful but not wrong.
        console.error(`[BACKFILL/${sourceId}] Cursor write failed - next cycle may re-do this slice: ${err.message}`);
    }

    return { source: sourceId, processed, stamped, error: errorMsg };
}

async function main() {
    console.log('[BACKFILL] V1 cycle 22 PR-CORE-3 - aggregated cumulative enrichment');

    const compounds = await loadJsonl(COMPOUNDS_FILE);
    if (compounds.length === 0) {
        console.error(`[BACKFILL] FATAL: ${COMPOUNDS_FILE} empty - refusing to write back nothing.`);
        process.exit(1);
    }
    console.log(`[BACKFILL] Loaded cumulative ${compounds.length} compounds`);

    const summaries = [];
    let anySuccess = false;
    for (const sourceId of Object.keys(SOURCE_CONFIG)) {
        try {
            const r = await backfillOneSource(sourceId, compounds);
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
