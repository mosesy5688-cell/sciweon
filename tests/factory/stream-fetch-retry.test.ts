/**
 * Tests for stream-fetch-retry -- the error-safe streaming download wrapper
 * that fixes the V0.6 PubChem bulk crash (unhandled stream 'error' on a
 * mid-download socket drop).
 *
 * Network-free: we inject `fetchImpl` (returns a fake `res.body` WHATWG
 * ReadableStream we drive byte-by-byte, optionally erroring mid-stream) and
 * `gunzipFactory` (a PassThrough so the test controls the decompressed bytes
 * with no real gzip). The error-safe pipeline must turn any stage failure
 * into a single rejected awaitable -- never an unhandled 'error' event.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import {
    downloadAndConsume, backoffDelay, isRetryableStreamError,
    StreamRetryError, NotFoundError, HttpError,
    DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS,
} from '../../scripts/factory/lib/stream-fetch-retry.js';

// Build a WHATWG ReadableStream that emits `chunks` then either ends cleanly
// or errors with `errAfter` set to an undici-like transient error.
function webStream(chunks: string[], errAfter?: Error) {
    return new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            if (errAfter) controller.error(errAfter);
            else controller.close();
        },
    });
}

function makeRes(status: number, body: ReadableStream | null) {
    return { ok: status >= 200 && status < 300, status, body } as any;
}

function socketDropError() {
    const e: any = new TypeError('terminated');
    e.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    return e;
}

// A consumer that drains the decompressed stream and concatenates text.
function makeConsumer() {
    const seen: string[] = [];
    const consume = async (stream: any) => {
        let buf = '';
        for await (const chunk of stream) buf += chunk.toString();
        seen.push(buf); // one entry per attempt that the consumer fully drained
    };
    return { consume, seen };
}

const fastOpts = { baseDelayMs: 1, maxDelayMs: 2, jitterMs: 0, gunzipFactory: () => new PassThrough() };

describe('downloadAndConsume', () => {
    it('(1) success on attempt 1 -> consumes full body, no retry', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeRes(200, webStream(['hello', 'world'])); };
        const { consume, seen } = makeConsumer();
        const out = await downloadAndConsume('https://x.test/a', { ...fastOpts, fetchImpl, consume });
        expect(out.attempts).toBe(1);
        expect(calls).toBe(1);
        expect(seen).toEqual(['helloworld']);
    });

    it('(2) mid-stream UND_ERR_SOCKET on attempt 1 then clean attempt 2 -> retried once, no attempt-1 leak', async () => {
        let calls = 0;
        const fetchImpl: any = async () => {
            calls++;
            return calls === 1
                ? makeRes(200, webStream(['partial-attempt-1-'], socketDropError()))
                : makeRes(200, webStream(['FULL-attempt-2']));
        };
        const { consume, seen } = makeConsumer();
        const out = await downloadAndConsume('https://x.test/b', { ...fastOpts, fetchImpl, consume });
        expect(out.attempts).toBe(2);
        expect(calls).toBe(2);
        // The only FULLY-DRAINED output is attempt 2; attempt 1's partial never
        // completes the consumer (it rejects), so it does not leak downstream.
        expect(seen).toEqual(['FULL-attempt-2']);
    });

    it('(3) persistent termination across maxAttempts -> rejects with classified StreamRetryError', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeRes(200, webStream(['x'], socketDropError())); };
        const { consume } = makeConsumer();
        const err = await downloadAndConsume('https://x.test/c', { ...fastOpts, fetchImpl, consume, maxAttempts: 3 })
            .then(() => null, e => e);
        expect(err).toBeInstanceOf(StreamRetryError);
        expect(err.attempts).toBe(3);
        expect(err.errorClass).toBe('UND_ERR_SOCKET');
        expect(calls).toBe(3);
    });

    it('(4) non-retryable consumer (parser) error -> no retry, propagates', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeRes(200, webStream(['data'])); };
        const consume = async () => { throw new Error('bad SDF record'); };
        const err = await downloadAndConsume('https://x.test/d', { ...fastOpts, fetchImpl, consume })
            .then(() => null, e => e);
        expect(err.message).toMatch(/bad SDF record/);
        expect(err).not.toBeInstanceOf(StreamRetryError);
        expect(calls).toBe(1); // not retried
    });

    it('(5) 404 -> NotFoundError, no retry (legitimate skip)', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeRes(404, null); };
        const { consume } = makeConsumer();
        const err = await downloadAndConsume('https://x.test/e', { ...fastOpts, fetchImpl, consume })
            .then(() => null, e => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err.status).toBe(404);
        expect(calls).toBe(1);
    });

    it('non-retryable 4xx (403) -> HttpError, no retry', async () => {
        let calls = 0;
        const fetchImpl: any = async () => { calls++; return makeRes(403, null); };
        const { consume } = makeConsumer();
        const err = await downloadAndConsume('https://x.test/f', { ...fastOpts, fetchImpl, consume })
            .then(() => null, e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(403);
        expect(calls).toBe(1);
    });

    it('retries on transient 503 from the initial fetch, then succeeds', async () => {
        let calls = 0;
        const fetchImpl: any = async () => {
            calls++;
            return calls === 1 ? makeRes(503, null) : makeRes(200, webStream(['ok']));
        };
        const { consume, seen } = makeConsumer();
        const out = await downloadAndConsume('https://x.test/g', { ...fastOpts, fetchImpl, consume });
        expect(out.attempts).toBe(2);
        expect(calls).toBe(2);
        expect(seen).toEqual(['ok']);
    });
});

describe('backoffDelay (LOCKED math: base * 2^attempt capped at maxDelay, + jitter)', () => {
    it('grows exponentially from the base and caps at maxDelay (no jitter)', () => {
        expect(backoffDelay(0, 2000, 60000, 0)).toBe(2000);
        expect(backoffDelay(1, 2000, 60000, 0)).toBe(4000);
        expect(backoffDelay(2, 2000, 60000, 0)).toBe(8000);
        expect(backoffDelay(5, 2000, 60000, 0)).toBe(60000);  // 64000 capped to 60000
        expect(backoffDelay(10, 2000, 60000, 0)).toBe(60000); // capped
    });

    it('jitter only adds within [0, jitterMs)', () => {
        for (let i = 0; i < 50; i++) {
            const d = backoffDelay(0, 2000, 60000, 1000);
            expect(d).toBeGreaterThanOrEqual(2000);
            expect(d).toBeLessThan(3000);
        }
    });

    it('uses the LOCKED default params', () => {
        expect(DEFAULT_BASE_DELAY_MS).toBe(2000);
        expect(DEFAULT_MAX_DELAY_MS).toBe(60000);
    });
});

describe('isRetryableStreamError classifier', () => {
    it('classifies the exact crash signatures as retryable', () => {
        expect(isRetryableStreamError(socketDropError())).toBe(true);
        expect(isRetryableStreamError(new TypeError('terminated'))).toBe(true);
        expect(isRetryableStreamError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
        expect(isRetryableStreamError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
        expect(isRetryableStreamError(Object.assign(new Error('socket hang up'), {}))).toBe(true);
        expect(isRetryableStreamError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    });

    it('does NOT classify parser / non-network errors as retryable', () => {
        expect(isRetryableStreamError(new Error('bad SDF record'))).toBe(false);
        expect(isRetryableStreamError(new HttpError(404, 'u'))).toBe(false);
        expect(isRetryableStreamError(null)).toBe(false);
        expect(isRetryableStreamError(undefined)).toBe(false);
    });
});
