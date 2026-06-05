/**
 * openFDA auth + paced-fetch helper (PR-FAERS-KEY / Step-5b).
 *
 * openFDA is the lone unauthenticated external source. Keyless it allows only
 * 1,000 req/day; with an api_key the ceiling rises to ~120,000/day (240/min).
 * Without a key the FAERS enricher blows the daily cap after ~1,000 records
 * and 429s for the rest of the day -- a self-sealing live silent-loss once the
 * adapter's error-as-empty stamps [] as permanently-done.
 *
 * WARN-DEGRADE (not fail-closed): unlike UMLS (NLM hard-403s keyless), openFDA
 * genuinely works keyless at 1,000/day, so a hard throw would break local /
 * diagnostic runs. The prod HARD stop lives in factory-2-process.yml's
 * pre-flight gate; the code only warns and degrades.
 *
 * REDACTION (P0): the key rides in the query string, so any thrown/logged URL
 * would leak the secret into the Actions log + the stage-2 log artifact. Every
 * URL that can reach a throw or a console line MUST be passed through
 * redactApiKey() first.
 *
 * PACING + RETRY: all openFDA requests (primary + retry, faers/label/recall)
 * flow through ONE shared TokenBucket so the true aggregate request rate is
 * bounded regardless of caller, and through fetch-with-retry (Retry-After +
 * exponential backoff + jitter) instead of the old fixed-5s single retry.
 */

import { TokenBucket } from './rate-limiter.js';
import { fetchJsonWithRetry } from './fetch-with-retry.js';

// Keyed ceiling is 240 req/min (4/s). We pace at ~3.4/s (~204/min, ~294ms
// spacing) leaving retry headroom under the 240/min wall. burst=1 -> strictly
// serial-paced. One bucket for ALL openFDA endpoints (shared daily/minute cap).
export const OPENFDA_RATE_PER_SEC = 3.4;
export const OPENFDA_RATE_LIMITER = new TokenBucket({ ratePerSec: OPENFDA_RATE_PER_SEC, burst: 1 });

// Per-record spacing exported for the enricher's drain loop telemetry. ~294ms.
export const OPENFDA_REQUEST_DELAY_MS = Math.ceil(1000 / OPENFDA_RATE_PER_SEC);

/**
 * Resolve the openFDA api_key. Absent -> LOUD warn + degrade to keyless (null).
 * Never throws: openFDA works keyless (the prod hard-stop is the workflow gate).
 */
let warnedOnce = false;
export function openFdaApiKey() {
    const key = process.env.OPENFDA_API_KEY;
    if (!key) {
        if (!warnedOnce) {
            console.warn('[OPENFDA-AUTH] OPENFDA_API_KEY absent -- DEGRADING to keyless '
                + '(1,000 req/day cap). FAERS enrichment will truncate in prod; set the '
                + 'OPENFDA_API_KEY secret. (warn-once)');
            warnedOnce = true;
        }
        return null;
    }
    return key;
}

/** Append &api_key=<encoded> to a built openFDA URL when a key is present. */
export function withApiKey(url) {
    const key = openFdaApiKey();
    if (!key) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}api_key=${encodeURIComponent(key)}`;
}

/** Redact any api_key=... param from a string (URL / error message / log line). */
export function redactApiKey(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/api_key=[^&\s]*/g, 'api_key=REDACTED');
}

// Status-class sentinel contract (part 3). A null return = a genuine 404
// (handled below) OR a FETCH FAILURE the caller must distinguish from
// genuine-empty. We mark fetch failures with a tagged error so callers can
// tell "404 -> genuine empty" from "429/5xx/timeout -> failure, stay eligible".
export class OpenFdaFetchError extends Error {
    constructor(message) {
        super(redactApiKey(message));
        this.name = 'OpenFdaFetchError';
        this.isFetchFailure = true;
    }
}

// Bucket-paced fetch impl injected into fetch-with-retry so BOTH the primary
// request and every retry attempt acquire a token (true rate bound).
async function pacedFetch(url, init) {
    await OPENFDA_RATE_LIMITER.acquire();
    return fetch(url, init);
}

/**
 * GET + parse one openFDA endpoint with key + pacing + redacted retry.
 *
 * Returns:
 *   - parsed JSON      on HTTP 200
 *   - null             on HTTP 404 (GENUINE EMPTY -- the load-bearing path)
 * Throws OpenFdaFetchError (redacted) on 429 / 5xx / timeout / network /
 *   parse error AFTER retries are exhausted -- the FETCH FAILURE sentinel.
 *
 * @param {string} url    the UN-keyed built URL (key appended here)
 * @param {object} [opts] { timeoutMs, maxAttempts, fetchImpl } test hooks
 */
export async function fetchOpenFda(url, opts = {}) {
    const { timeoutMs = 20000, maxAttempts = 3, fetchImpl = pacedFetch } = opts;
    const keyed = withApiKey(url);
    try {
        return await fetchJsonWithRetry(keyed, {
            fetchImpl, timeoutMs, maxAttempts,
            allow404: true,        // 404 -> null (genuine empty), not a failure
            baseDelayMs: 800, jitterMs: 400, maxRetryAfterMs: 30000,
        });
    } catch (err) {
        // fetch-with-retry throws on exhausted 429/5xx, network, timeout, and
        // non-retry HTTP (>=400 except 404). All are FETCH FAILURES here: the
        // adapter must NOT stamp genuine-empty. Redact before re-raising so the
        // key never reaches a logged/thrown string.
        throw new OpenFdaFetchError(err?.message ?? String(err));
    }
}
