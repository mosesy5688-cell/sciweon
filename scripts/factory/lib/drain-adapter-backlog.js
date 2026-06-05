/**
 * Drain-until-cleared adapter helper (cycle 23 PR-CORE-Drain V5).
 *
 * Replaces chunk-and-exit pattern that forced manual F2 re-dispatch after
 * asymmetric corpus growth. Drives one adapter's eligible backlog through
 * multiple chunkIterator slices in one F2 run, exiting when corpus wraps,
 * EWMA budget would breach timeBudgetMs, or eligible is empty at entry.
 *
 * V5 architectural locks (post-architect audit):
 *   - Loop-out terminal commit: ZERO I/O in loop. Helper mutates eligible
 *     records in place via enrichOne; orchestrator does ONE writeJsonl +
 *     ONE writeCursor AFTER helper returns. GHA crash semantics: nothing
 *     committed -> next cycle redoes chunk idempotently (isEligible safety).
 *   - EWMA budget gate (alpha=0.7, premium=1.3): defeats V3 Variance
 *     Penalty Decay Paradox of max-tracking formula.
 *   - Zero-payload callback: helper does NOT touch master arrays.
 *   - Empty-set short-circuit at entry: defends chunkIterator -1 edge.
 *
 * Pure orchestration: NO @aws-sdk imports, NO fs imports.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Empirical cycle 22-23 unichem-class wall-time baseline (5000 x 200ms ~ 17 min).
export const DEFAULT_CHUNK_DURATION_ESTIMATE_MS = 17 * 60 * 1000;
const EWMA_ALPHA = 0.7;
const ROBUSTNESS_PREMIUM = 1.3;
const COLD_START_PAD = 1.1;

function emptyResult(initialCursor) {
    return {
        terminatedBy: 'empty', chunksDrained: 0, processedInRun: 0,
        remainingBacklog: 0, finalCursor: initialCursor, finalCursorResult: null,
        drainErrorCount: 0,
    };
}

function projectNextChunkMs(chunksDrained, windowMs, coldStartEstimateMs) {
    if (chunksDrained > 0) return windowMs * ROBUSTNESS_PREMIUM;
    return coldStartEstimateMs * COLD_START_PAD;
}

function updateEwma(prevWindowMs, lastChunkMs) {
    if (prevWindowMs === 0) return lastChunkMs;
    return prevWindowMs * (1 - EWMA_ALPHA) + lastChunkMs * EWMA_ALPHA;
}

/**
 * Pure orchestration. Required params: eligible, enrichOne, chunkIterator,
 * chunkSize, timeBudgetMs, coldStartEstimateMs, sleepMsBetween, initialCursor.
 * Optional: logPrefix, logEveryNRecords.
 * Returns: {terminatedBy, chunksDrained, processedInRun, remainingBacklog,
 *          finalCursor, finalCursorResult}.
 */
export async function drainAdapterBacklog({
    eligible, enrichOne, chunkIterator, chunkSize, timeBudgetMs,
    coldStartEstimateMs, sleepMsBetween, initialCursor,
    logPrefix = '[DRAIN]', logEveryNRecords = 100,
}) {
    if (!eligible || eligible.length === 0) return emptyResult(initialCursor);
    if (typeof enrichOne !== 'function' || typeof chunkIterator !== 'function'
        || !(chunkSize > 0) || !(timeBudgetMs > 0) || !(coldStartEstimateMs > 0)) {
        throw new Error('drainAdapterBacklog: missing or invalid required param');
    }

    const runStart = Date.now();
    let cursor = initialCursor;
    let chunksDrained = 0;
    let processedInRun = 0;
    let windowMs = 0;
    let wrapped = false;
    let lastChunkResult = null;
    let drainErrorCount = 0;   // belt-guard: count of enrichOne throws this run.

    while (!wrapped) {
        const elapsed = Date.now() - runStart;
        const projected = projectNextChunkMs(chunksDrained, windowMs, coldStartEstimateMs);
        if (elapsed + projected > timeBudgetMs) {
            return {
                terminatedBy: 'budget', chunksDrained, processedInRun,
                remainingBacklog: lastChunkResult
                    ? Math.max(0, lastChunkResult.totalEligible - processedInRun)
                    : eligible.length,
                finalCursor: cursor, finalCursorResult: lastChunkResult,
                drainErrorCount,
            };
        }

        // Effective chunkSize cap: prevent chunkIterator's wrap from re-emitting
        // head records once we've drained the tail. Without this, a corpus of
        // N records with chunkSize C where N % C != 0 would cause the final
        // chunk to wrap + re-process the first (C - remainder) records.
        const effectiveChunkSize = lastChunkResult
            ? Math.min(chunkSize, Math.max(0, lastChunkResult.totalEligible - processedInRun))
            : chunkSize;
        if (effectiveChunkSize === 0) { wrapped = true; break; }

        const chunkStart = Date.now();
        const result = chunkIterator(eligible, cursor, effectiveChunkSize);
        const { slice, nextCursorId, wrapped: w } = result;
        if (slice.length === 0) { wrapped = w; lastChunkResult = result; break; }

        let inChunk = 0;
        for (const rec of slice) {
            // Belt-and-suspenders poison guard ([[cross_cycle_silent_data_loss]]):
            // a single record's enrichOne throw must NOT abort the whole stage
            // (every cron) -- it would starve all never-queried records behind it.
            // enrichers SHOULD return a sentinel rather than throw (the suspenders);
            // this is the belt. LOUD (never silent): the throw is logged + counted,
            // and the record is left un-mutated so isEligible keeps it eligible for
            // a bounded retry (the enricher's own per-record attempt counter bounds
            // requery so the eligible denominator cannot grow unboundedly).
            try {
                await enrichOne(rec);
            } catch (err) {
                drainErrorCount += 1;
                console.error(`${logPrefix} enrichOne THREW on record ${rec?.id ?? '(no id)'}: ${err?.message ?? err} -- record left eligible, continuing`);
            }
            inChunk += 1;
            if (logEveryNRecords > 0 && (inChunk % logEveryNRecords === 0 || inChunk === slice.length)) {
                console.log(`${logPrefix} chunk ${chunksDrained + 1} | ${inChunk}/${slice.length} processed`);
            }
            if (sleepMsBetween > 0) await sleep(sleepMsBetween);
        }

        processedInRun += slice.length;
        chunksDrained += 1;
        wrapped = w;
        cursor = { ...(cursor ?? {}), cursor_id: nextCursorId };
        lastChunkResult = result;

        const lastChunkMs = Date.now() - chunkStart;
        windowMs = updateEwma(windowMs, lastChunkMs);
        console.log(`${logPrefix} chunk ${chunksDrained} complete | wall=${(lastChunkMs / 1000).toFixed(1)}s | ewma=${(windowMs / 1000).toFixed(1)}s | wrapped=${wrapped}`);

        // Drain-completion early exit: chunkIterator's wrap semantics
        // re-emit head records once the cursor reaches the tail when
        // remaining == chunkSize exactly. After we've processed all
        // eligible records once, exit BEFORE that re-emit happens.
        // Otherwise enrichOne would be called twice on the head subset.
        if (processedInRun >= result.totalEligible) { wrapped = true; break; }
    }

    return {
        terminatedBy: 'wrapped', chunksDrained, processedInRun,
        remainingBacklog: 0, finalCursor: cursor, finalCursorResult: lastChunkResult,
        drainErrorCount,
    };
}
