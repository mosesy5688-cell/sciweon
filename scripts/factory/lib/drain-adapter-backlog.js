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

// P-8 GAP-B: canonical stop-reason set surfaced alongside terminatedBy. The
// legacy terminatedBy ('empty'|'budget'|'wrapped') is PRESERVED for existing
// callers/tests; stop_reason is the operator-facing P-8 vocabulary.
export const STOP_REASON = Object.freeze({
    MAX_RECORDS_REACHED: 'MAX_RECORDS_REACHED',
    TIME_BUDGET_REACHED: 'TIME_BUDGET_REACHED',
    BACKLOG_EXHAUSTED: 'BACKLOG_EXHAUSTED',
    SOURCE_FAILURE: 'SOURCE_FAILURE',
    INVARIANT_FAILURE: 'INVARIANT_FAILURE',
});

// P-8 GAP-B: parse an optional record-cap env var. null when unset/blank;
// throws on a non-negative-integer violation so a typo never silently caps.
export function parseMaxRecordsEnv(name) {
    const raw = process.env[name];
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${name} invalid: '${raw}' (expected a non-negative integer)`);
    }
    return n;
}

// P-8 GAP-B: canonical evidence block for a per-source drain outcome. stop_reason
// is taken from the drain result; an in-drain throw passes an explicit override.
export function buildDrainEvidence({ requestedMaxRecords, stampedThisRun, attemptedThisRun, remainingBacklog, stopReason, cursorBefore, cursorAfter }) {
    return {
        requested_max_records: requestedMaxRecords ?? null,
        stamped_this_run: stampedThisRun,
        attempted_this_run: attemptedThisRun,
        remaining_backlog: remainingBacklog ?? null,
        stop_reason: stopReason,
        cursor_before: cursorBefore ?? null,
        cursor_after: cursorAfter ?? null,
    };
}

function emptyResult(initialCursor) {
    return {
        terminatedBy: 'empty', chunksDrained: 0, processedInRun: 0,
        remainingBacklog: 0, finalCursor: initialCursor, finalCursorResult: null,
        stopReason: STOP_REASON.BACKLOG_EXHAUSTED,
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
    logPrefix = '[DRAIN]', logEveryNRecords = 100, maxRecords = null,
}) {
    if (!eligible || eligible.length === 0) return emptyResult(initialCursor);
    if (typeof enrichOne !== 'function' || typeof chunkIterator !== 'function'
        || !(chunkSize > 0) || !(timeBudgetMs > 0) || !(coldStartEstimateMs > 0)) {
        throw new Error('drainAdapterBacklog: missing or invalid required param');
    }
    // P-8 GAP-B: optional HARD record cap. null/unset = no cap (today's
    // behavior). A finite cap MUST be a positive integer; a <=0 cap is an
    // INVARIANT_FAILURE (caller passed garbage) rather than a silent no-op.
    const hasCap = maxRecords != null;
    if (hasCap && !(Number.isInteger(maxRecords) && maxRecords >= 0)) {
        throw new Error('drainAdapterBacklog: maxRecords must be a non-negative integer when set');
    }
    if (hasCap && maxRecords === 0) {
        return {
            terminatedBy: 'budget', chunksDrained: 0, processedInRun: 0,
            remainingBacklog: eligible.length, finalCursor: initialCursor,
            finalCursorResult: null, stopReason: STOP_REASON.MAX_RECORDS_REACHED,
        };
    }

    const runStart = Date.now();
    let cursor = initialCursor;
    let chunksDrained = 0;
    let processedInRun = 0;
    let windowMs = 0;
    let wrapped = false;
    let lastChunkResult = null;

    while (!wrapped) {
        // P-8 GAP-B: HARD record cap checked BEFORE fetching/processing a chunk
        // so a non-2000-multiple cap never overshoots. If we have already
        // stamped exactly maxRecords, stop now (we never process record max+1).
        if (hasCap && processedInRun >= maxRecords) {
            return {
                terminatedBy: 'budget', chunksDrained, processedInRun,
                remainingBacklog: lastChunkResult
                    ? Math.max(0, lastChunkResult.totalEligible - processedInRun)
                    : Math.max(0, eligible.length - processedInRun),
                finalCursor: cursor, finalCursorResult: lastChunkResult,
                stopReason: STOP_REASON.MAX_RECORDS_REACHED,
            };
        }

        const elapsed = Date.now() - runStart;
        const projected = projectNextChunkMs(chunksDrained, windowMs, coldStartEstimateMs);
        if (elapsed + projected > timeBudgetMs) {
            return {
                terminatedBy: 'budget', chunksDrained, processedInRun,
                remainingBacklog: lastChunkResult
                    ? Math.max(0, lastChunkResult.totalEligible - processedInRun)
                    : eligible.length,
                finalCursor: cursor, finalCursorResult: lastChunkResult,
                stopReason: STOP_REASON.TIME_BUDGET_REACHED,
            };
        }

        // Effective chunkSize cap: prevent chunkIterator's wrap from re-emitting
        // head records once we've drained the tail. Without this, a corpus of
        // N records with chunkSize C where N % C != 0 would cause the final
        // chunk to wrap + re-process the first (C - remainder) records.
        // P-8 GAP-B: ALSO clamp to the remaining record-cap budget so a cap that
        // is NOT a multiple of chunkSize (e.g. 8000 with a 3000 chunk, or a cap
        // < chunkSize) processes AT MOST `maxRecords - processedInRun` more
        // records this chunk and never overshoots to max+1.
        let effectiveChunkSize = lastChunkResult
            ? Math.min(chunkSize, Math.max(0, lastChunkResult.totalEligible - processedInRun))
            : chunkSize;
        if (hasCap) {
            effectiveChunkSize = Math.min(effectiveChunkSize, Math.max(0, maxRecords - processedInRun));
        }
        if (effectiveChunkSize === 0) { wrapped = true; break; }

        const chunkStart = Date.now();
        const result = chunkIterator(eligible, cursor, effectiveChunkSize);
        const { slice, nextCursorId, wrapped: w } = result;
        if (slice.length === 0) { wrapped = w; lastChunkResult = result; break; }

        let inChunk = 0;
        for (const rec of slice) {
            await enrichOne(rec);
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

        // P-8 GAP-B invariant: the pre-chunk effectiveChunkSize clamp guarantees
        // we never process record max+1. Assert it (a clamp regression must throw
        // an INVARIANT_FAILURE, never silently overshoot the founder's cap).
        if (hasCap && processedInRun > maxRecords) {
            throw new Error(`[DRAIN] INVARIANT_FAILURE: processedInRun (${processedInRun}) overshot maxRecords (${maxRecords})`);
        }

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

    // P-8 GAP-B: if the loop ended because the record cap was hit (not because
    // the backlog genuinely wrapped), surface MAX_RECORDS_REACHED + the true
    // remaining backlog. Otherwise the backlog is exhausted (remaining 0).
    const capStopped = hasCap && processedInRun >= maxRecords
        && lastChunkResult && processedInRun < lastChunkResult.totalEligible;
    if (capStopped) {
        return {
            terminatedBy: 'wrapped', chunksDrained, processedInRun,
            remainingBacklog: Math.max(0, lastChunkResult.totalEligible - processedInRun),
            finalCursor: cursor, finalCursorResult: lastChunkResult,
            stopReason: STOP_REASON.MAX_RECORDS_REACHED,
        };
    }
    return {
        terminatedBy: 'wrapped', chunksDrained, processedInRun,
        remainingBacklog: 0, finalCursor: cursor, finalCursorResult: lastChunkResult,
        stopReason: STOP_REASON.BACKLOG_EXHAUSTED,
    };
}
