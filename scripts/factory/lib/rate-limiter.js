/**
 * Token-bucket rate limiter (PR-B coverage-ceiling, shared F3 substrate).
 *
 * The F3 linkers (trial-linker / paper-linker) move from a fixed-LIMIT=50
 * head-of-array scan to a cursored drain that queries MANY more compounds per
 * run under bounded pMap concurrency. With N concurrent workers each calling an
 * external API, a per-task `await sleep(delay)` no longer bounds the AGGREGATE
 * request rate (the workers' sleeps overlap). A shared token bucket bounds the
 * TRUE request rate against each external service regardless of worker count.
 *
 * Design (mirrors the repo's no-external-dependency convention, e.g.
 * lib/p-map.js -- sciweon stays inside its $10/mo cap with zero npm-surface
 * adds for ~30 LOC of well-trodden logic):
 *   - Continuous refill: tokens accrue at `ratePerSec` tokens/second, capped at
 *     `burst` (the bucket capacity). Continuous (not tick-based) refill so the
 *     average sustained rate equals `ratePerSec` exactly, no edge quantization.
 *   - acquire() resolves immediately when a whole token is available, else waits
 *     the exact time for the next token to accrue, then consumes it. Waiters are
 *     served in FIFO order so no caller is starved under contention.
 *   - One bucket per external service: CT.gov and OpenAlex each get their own
 *     (see TRIAL_RATE_LIMITER / PAPER_RATE_LIMITER below) so a slow CT.gov run
 *     never consumes OpenAlex's budget and vice-versa.
 *
 * Determinism note: this module reads the clock (rate limiting is inherently
 * time-coupled), so it is NOT a pure/deterministic transform and is never on
 * the byte-identical-output path -- it only paces network I/O. The pure cursor
 * math (lib/enrichment-cursor.js) remains deterministic.
 *
 * Published rate limits used by the shared instances below (verified 2026-06-05,
 * sources cited in the PR body):
 *   - OpenAlex: 10 req/s, 100,000 req/day (polite pool via mailto). We use 10/s.
 *   - CT.gov API v2: NLM publishes no explicit per-second figure; the community
 *     -documented sustained ceiling is ~50 req/min (~0.83 req/s). We use the
 *     conservative 50/min rather than a higher guess, leaving generous headroom.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class TokenBucket {
    /**
     * @param {object} opts
     * @param {number} opts.ratePerSec  sustained token refill rate (tokens/sec), > 0
     * @param {number} [opts.burst]     bucket capacity (max tokens held); defaults to
     *                                  max(1, ceil(ratePerSec)). A burst of 1 makes the
     *                                  limiter strictly serial-paced; a larger burst
     *                                  lets short bursts through while holding the
     *                                  long-run average at ratePerSec.
     * @param {() => number} [opts.now] injectable clock (ms since epoch) for tests.
     */
    constructor({ ratePerSec, burst, now } = {}) {
        if (!(ratePerSec > 0)) throw new Error(`TokenBucket: ratePerSec must be > 0, got ${ratePerSec}`);
        this.ratePerSec = ratePerSec;
        this.capacity = burst != null ? burst : Math.max(1, Math.ceil(ratePerSec));
        if (!(this.capacity >= 1)) throw new Error(`TokenBucket: burst must be >= 1, got ${burst}`);
        this._now = now || (() => Date.now());
        this.tokens = this.capacity;     // start full
        this.lastRefill = this._now();
        // FIFO serialization: each acquire() chains onto the previous so waiters
        // are granted in call order (no starvation under heavy contention).
        this._tail = Promise.resolve();
    }

    // Accrue tokens for the wall-clock elapsed since the last refill, capped at
    // capacity. Pure arithmetic over the injected clock.
    _refill() {
        const nowMs = this._now();
        const elapsedSec = (nowMs - this.lastRefill) / 1000;
        if (elapsedSec > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
            this.lastRefill = nowMs;
        }
    }

    // Milliseconds until at least one whole token is available (0 if available now).
    _msUntilToken() {
        this._refill();
        if (this.tokens >= 1) return 0;
        const deficit = 1 - this.tokens;
        return Math.ceil((deficit / this.ratePerSec) * 1000);
    }

    /**
     * Acquire one token, waiting if necessary. Resolves once a token has been
     * consumed. FIFO across concurrent callers.
     * @returns {Promise<void>}
     */
    acquire() {
        const run = async () => {
            // Loop because between the computed wait and re-check, the continuous
            // refill might still leave us a hair short (clock granularity); re-wait
            // the remainder. Converges in 1-2 iterations.
            for (;;) {
                const waitMs = this._msUntilToken();
                if (waitMs === 0) {
                    this.tokens -= 1;
                    return;
                }
                await sleep(waitMs);
            }
        };
        // Chain onto the FIFO tail so grants are ordered; swallow upstream
        // rejection so one waiter's failure cannot poison the chain (acquire
        // itself never rejects under normal operation).
        const result = this._tail.then(run, run);
        this._tail = result.catch(() => {});
        return result;
    }

    /** Current token count after refill (test/telemetry helper). */
    available() {
        this._refill();
        return this.tokens;
    }
}

// ---- Shared per-service instances (one bucket per external service) ----------
// CT.gov API v2: conservative 50 req/min (~0.83 req/s). burst=1 -> strictly paced.
export const CTGOV_RATE_PER_SEC = 50 / 60;
export const TRIAL_RATE_LIMITER = new TokenBucket({ ratePerSec: CTGOV_RATE_PER_SEC, burst: 1 });

// OpenAlex polite pool: 10 req/s (and 100k/day, far above any single F3 run).
export const OPENALEX_RATE_PER_SEC = 10;
export const PAPER_RATE_LIMITER = new TokenBucket({ ratePerSec: OPENALEX_RATE_PER_SEC, burst: 10 });
