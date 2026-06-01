/**
 * stream-fetch-retry -- streaming-download retry wrapper for bulk SDF harvest.
 *
 * Root-cause fix for the V0.6 PubChem bulk crash: when PubChem drops the
 * socket mid-download, `Readable.fromWeb(res.body).pipe(gunzip)` emits an
 * unhandled stream `'error'` event (UND_ERR_SOCKET / "terminated") that the
 * async-iterator try/catch never sees -> the worker process throws and dies,
 * no manifest is written, the fan-in (`needs: bulk-harvest`) is skipped, and
 * the whole monthly refresh cycle is lost.
 *
 * This module builds an ERROR-SAFE pipeline with stream.pipeline (from
 * stream/promises): an error from ANY stage (network Readable / gunzip /
 * consumer) rejects a single awaitable instead of crashing the process. On a
 * TRANSIENT failure it retries with exponential backoff + jitter (mirroring
 * lib/fetch-with-retry.js's math). Non-transient errors (404, other 4xx,
 * parser bugs) are NOT retried -- the caller treats those as a legitimate
 * skip or a real fault.
 *
 * Determinism: a retried attempt re-downloads from byte 0, so a clean attempt
 * re-parses the identical input -> byte-identical output. The caller is
 * responsible for the atomic temp-then-rename that guarantees a crashed
 * attempt leaves ZERO half-written records (see bulk-pubchem-harvest.js).
 *
 * Pure + unit-testable: inject `fetchImpl` + a fake `res.body` stream; no real
 * network in tests.
 */

import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';

// LOCKED retry params (see PR spec). baseDelayMs * 2^attempt capped at maxDelayMs, + jitter.
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 2000;
export const DEFAULT_MAX_DELAY_MS = 60000;
export const DEFAULT_JITTER_MS = 1000;

// Transient HTTP statuses retried on the INITIAL fetch (before the stream opens).
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Exponential backoff with jitter, capped at maxDelayMs.
 * Mirrors fetch-with-retry.js's backoffDelay shape.
 */
export function backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterMs) {
    const exp = baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(exp, maxDelayMs);
    return capped + Math.floor(Math.random() * jitterMs);
}

/**
 * Classifies whether a thrown error from a streaming download is a TRANSIENT
 * network drop worth retrying. Covers the exact undici signatures seen in the
 * crash (UND_ERR_SOCKET / "terminated" / "other side closed") plus the common
 * reset/timeout/abort family. A parser error or any non-network fault is NOT
 * retryable.
 */
export function isRetryableStreamError(err) {
    if (!err) return false;
    const code = err.code || err.cause?.code;
    if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
        || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ENOTFOUND'
        || code === 'ABORT_ERR' || code === 'UND_ERR_CONNECT_TIMEOUT'
        || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
        return true;
    }
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    const msg = (err.message || '') + ' ' + (err.cause?.message || '');
    return /terminated|other side closed|socket hang up|premature close|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET/i.test(msg);
}

/** Marker thrown after attempts are exhausted; carries the classified cause. */
export class StreamRetryError extends Error {
    constructor(message, { attempts, lastError } = {}) {
        super(message);
        this.name = 'StreamRetryError';
        this.attempts = attempts;
        this.lastError = lastError;
        this.errorClass = lastError?.code || lastError?.cause?.code || lastError?.name || 'unknown';
    }
}

/** Thrown when the upstream returns 404; caller treats this as a legitimate skip. */
export class NotFoundError extends Error {
    constructor(url) {
        super(`HTTP 404: ${url}`);
        this.name = 'NotFoundError';
        this.status = 404;
    }
}

/** Thrown for a non-retryable HTTP status (a real fault, not a transient blip). */
export class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status}: ${url}`);
        this.name = 'HttpError';
        this.status = status;
    }
}

/**
 * downloadAndConsume -- fetch a gzip stream and feed parsed bytes to `consume`
 * through an error-safe pipeline, retrying transient mid-stream drops.
 *
 * @param {string} url
 * @param {object} opts
 * @param {number}   opts.maxAttempts
 * @param {number}   opts.baseDelayMs
 * @param {number}   opts.maxDelayMs
 * @param {number}   opts.jitterMs
 * @param {function} opts.fetchImpl       injectable fetch (defaults to global)
 * @param {function} opts.gunzipFactory   injectable gunzip stream factory (tests)
 * @param {function} opts.isRetryable     error classifier (defaults to isRetryableStreamError)
 * @param {function} opts.consume         (decompressedStream, attempt) => Promise; the final pipeline stage
 * @param {function} opts.onRetry         optional (attempt, err) => void telemetry hook
 * @returns {Promise<{attempts:number}>}  resolves only on a CLEAN full-stream completion
 */
export async function downloadAndConsume(url, opts = {}) {
    const {
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        maxDelayMs = DEFAULT_MAX_DELAY_MS,
        jitterMs = DEFAULT_JITTER_MS,
        fetchImpl = fetch,
        gunzipFactory = createGunzip,
        isRetryable = isRetryableStreamError,
        consume,
        onRetry,
    } = opts;

    if (typeof consume !== 'function') throw new TypeError('downloadAndConsume: opts.consume must be a function');

    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const res = await fetchImpl(url);
            if (!res.ok) {
                if (res.status === 404) throw new NotFoundError(url);
                if (TRANSIENT_STATUSES.has(res.status)) {
                    lastError = new HttpError(res.status, url);
                    if (attempt + 1 >= maxAttempts) break;
                    if (onRetry) onRetry(attempt + 1, lastError);
                    await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterMs));
                    continue;
                }
                throw new HttpError(res.status, url); // non-retryable 4xx
            }
            if (!res.body) throw new Error(`no response body: ${url}`);

            const source = Readable.fromWeb(res.body);
            const gunzip = gunzipFactory();
            // Error-safe: any stage failing rejects this awaitable (no unhandled 'error').
            await pipeline(source, gunzip, stream => consume(stream, attempt));
            return { attempts: attempt + 1 };
        } catch (err) {
            // 404 and non-retryable HTTP/parser errors propagate immediately.
            if (err instanceof NotFoundError) throw err;
            if (err instanceof HttpError && !TRANSIENT_STATUSES.has(err.status)) throw err;
            if (!isRetryable(err)) throw err;

            lastError = err;
            if (attempt + 1 >= maxAttempts) break;
            if (onRetry) onRetry(attempt + 1, err);
            await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterMs));
        }
    }

    throw new StreamRetryError(
        `downloadAndConsume: exhausted ${maxAttempts} attempts for ${url} (last: ${lastError?.message || 'unknown'})`,
        { attempts: maxAttempts, lastError },
    );
}
