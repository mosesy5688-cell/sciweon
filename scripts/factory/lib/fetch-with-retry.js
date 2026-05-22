/**
 * fetchJsonWithRetry — generic in-run HTTP retry helper.
 *
 * Wraps `fetch` + `res.json()` with exponential backoff + jitter for
 * transient failures (network errors, 5xx, 429 Too Many Requests).
 * The cross-run R2 retry queue (lib/harvest-retry-queue.js) catches what
 * survives this — but most upstream blips resolve on attempt 2 or 3,
 * keeping the queue depth low and the safety cap from tripping.
 *
 * Cycle 21 root-cause fix for F1 run 26269624764: 2113 of 2890 CIDs
 * failed in one batch because pubchem-adapter.js had zero in-run retry,
 * tripping the queue cap and halting the cron.
 *
 * Honors `Retry-After` (numeric seconds only — HTTP-date deferred).
 * Bounded by `maxRetryAfterMs` so a hostile or buggy upstream can't
 * stall the run for hours.
 */

const DEFAULT_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseRetryAfter(header, maxMs) {
    if (!header) return null;
    const seconds = Number(header);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, maxMs);
}

function backoffDelay(attempt, baseDelayMs, jitterMs) {
    return baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * jitterMs);
}

export async function fetchJsonWithRetry(url, opts = {}) {
    const {
        maxAttempts = 3,
        baseDelayMs = 500,
        jitterMs = 300,
        timeoutMs = 15000,
        retryStatuses = DEFAULT_RETRY_STATUSES,
        allow404 = false,
        maxRetryAfterMs = 30000,
        fetchImpl = fetch,
    } = opts;

    const retrySet = retryStatuses instanceof Set ? retryStatuses : new Set(retryStatuses);
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
            if (res.ok) return res.json();
            if (allow404 && res.status === 404) return null;
            if (!retrySet.has(res.status)) {
                throw new Error(`HTTP ${res.status}: ${url}`);
            }
            // Retryable status; honor Retry-After then back off.
            const retryAfterMs = parseRetryAfter(res.headers.get?.('retry-after'), maxRetryAfterMs);
            lastError = new Error(`HTTP ${res.status}: ${url} (attempt ${attempt + 1}/${maxAttempts})`);
            if (attempt + 1 >= maxAttempts) break;
            await sleep(retryAfterMs ?? backoffDelay(attempt, baseDelayMs, jitterMs));
        } catch (err) {
            // Network errors / AbortSignal timeout / non-retry HTTP throw above.
            if (err.message?.startsWith('HTTP ') && !err.message.includes('attempt ')) throw err;
            lastError = err;
            if (attempt + 1 >= maxAttempts) break;
            await sleep(backoffDelay(attempt, baseDelayMs, jitterMs));
        }
    }
    throw lastError ?? new Error(`fetchJsonWithRetry: exhausted ${maxAttempts} attempts for ${url}`);
}
