// @ts-nocheck
/**
 * RK-15 — swapLatestPointer FAIL-LOUD on conditional-unsupported.
 *
 * The defect (founder ruling: deleted): swapLatestPointer had an
 * UNCONDITIONAL-PUT fallback — on a conditional-UNSUPPORTED error it did
 * `delete put.IfMatch; delete put.IfNoneMatch;` then re-PUT snapshots/latest.json
 * UNCONDITIONALLY. latest.json is the ONE mutable pointer; an unconditional
 * overwrite path contradicts RK-15's immutable-publish contract.
 *
 * Contract asserted here:
 *   - conditional-UNSUPPORTED (400/501/NotImplemented on a conditional PUT) ->
 *     a TYPED fatal (ConditionalUnsupportedError); latest.json left UNCHANGED;
 *     NO unconditional PUT is ever sent.
 *   - 412 / stale-ETag -> re-read current latest -> bounded retry; EVERY retry
 *     still carries If-Match (or IfNoneMatch:'*' on first-create). Eventually
 *     succeeds when the store stops conflicting.
 *   - consecutive 412 beyond SWAP_MAX_RETRIES -> throws; latest unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
    swapLatestPointer,
    ConditionalUnsupportedError,
} from '../../scripts/factory/lib/publish-shards-and-swap.js';

const LATEST_KEY = 'snapshots/latest.json';

/**
 * Mock S3 client that RECORDS every command so a test can assert on the exact
 * PUT sequence (and that no unconditional PUT is ever sent). `putBehavior` is an
 * optional hook: (input, putIndex) => 'ok' | Error — return an Error to make
 * that PUT throw (used to inject 412 / conditional-unsupported), 'ok' to let it
 * store normally.
 */
function makeMockClient(initial, putBehavior) {
    const store = new Map();
    const commands = []; // { type: 'GET'|'PUT', input }
    let seq = 0;
    let putIndex = 0;
    if (initial !== undefined) {
        store.set(LATEST_KEY, { body: JSON.stringify(initial), etag: `"etag-${++seq}"` });
    }
    const client = {
        async send(cmd) {
            const type = cmd.constructor.name === 'GetObjectCommand' ? 'GET' : 'PUT';
            commands.push({ type, input: cmd.input });
            const { Key } = cmd.input;
            if (type === 'GET') {
                const o = store.get(Key);
                if (!o) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
                async function* gen() { yield Buffer.from(o.body, 'utf-8'); }
                return { ETag: o.etag, Body: gen() };
            }
            // PUT
            const idx = putIndex++;
            if (putBehavior) {
                const r = putBehavior(cmd.input, idx);
                if (r instanceof Error) throw r;
            }
            store.set(Key, { body: cmd.input.Body, etag: `"etag-${++seq}"` });
            return {};
        },
    };
    return {
        client,
        commands,
        puts: () => commands.filter(c => c.type === 'PUT'),
        gets: () => commands.filter(c => c.type === 'GET'),
        current: () => {
            const o = store.get(LATEST_KEY);
            return o ? JSON.parse(o.body) : undefined;
        },
        currentEtag: () => store.get(LATEST_KEY)?.etag,
    };
}

function err412() {
    const e = new Error('At least one of the pre-conditions you specified did not hold');
    e.name = 'PreconditionFailed';
    e.$metadata = { httpStatusCode: 412 };
    return e;
}

function errConditionalUnsupported(code = 501) {
    const e = new Error('NotImplemented: conditional writes are not implemented');
    e.name = 'NotImplemented';
    e.$metadata = { httpStatusCode: code };
    return e;
}

/** A PUT carries a conditional header iff IfMatch or IfNoneMatch is set. */
function isConditional(input) {
    return input.IfMatch !== undefined || input.IfNoneMatch !== undefined;
}

describe('swapLatestPointer — fail-loud on conditional-unsupported (RK-15)', () => {
    it('conditional-UNSUPPORTED (501) -> throws ConditionalUnsupportedError; exactly one (conditional) PUT; no unconditional PUT; latest UNCHANGED', async () => {
        const prior = { latest_snapshot_date: '2026-06-04' };
        const mock = makeMockClient(prior, () => errConditionalUnsupported(501));
        const beforeEtag = mock.currentEtag();

        await expect(
            swapLatestPointer(mock.client, 'b', { latest_snapshot_date: '2026-06-05' }, ['latest_snapshot_date']),
        ).rejects.toBeInstanceOf(ConditionalUnsupportedError);

        const puts = mock.puts();
        expect(puts).toHaveLength(1); // EXACTLY one conditional PUT attempt, then loud throw
        expect(isConditional(puts[0].input)).toBe(true);
        // NO unconditional PUT anywhere.
        expect(mock.puts().some(p => !isConditional(p.input))).toBe(false);
        // latest.json UNCHANGED (content + etag).
        expect(mock.current()).toEqual(prior);
        expect(mock.currentEtag()).toBe(beforeEtag);
    });

    it('conditional-UNSUPPORTED (400) is ALSO a typed fatal (not a silent unconditional write)', async () => {
        const prior = { latest_snapshot_date: '2026-06-04' };
        const mock = makeMockClient(prior, () => errConditionalUnsupported(400));
        await expect(
            swapLatestPointer(mock.client, 'b', { latest_snapshot_date: '2026-06-05' }, ['latest_snapshot_date']),
        ).rejects.toBeInstanceOf(ConditionalUnsupportedError);
        expect(mock.current()).toEqual(prior);
        // No PUT without a conditional header was ever sent.
        expect(mock.puts().every(p => isConditional(p.input))).toBe(true);
    });

    it('NO PutObjectCommand is EVER sent without a conditional header (across the whole flow)', async () => {
        // A couple of 412s then success — inspect every recorded PUT.
        let n = 0;
        const mock = makeMockClient({ latest_snapshot_date: '2026-06-04' }, () => (n++ < 2 ? err412() : 'ok'));
        await swapLatestPointer(mock.client, 'b', { latest_snapshot_date: '2026-06-05' }, ['latest_snapshot_date']);
        const puts = mock.puts();
        expect(puts.length).toBeGreaterThanOrEqual(3);
        for (const p of puts) {
            expect(isConditional(p.input)).toBe(true);
        }
    });

    it('412 -> re-reads latest (fresh GET) and retries with If-Match set; succeeds when conflict clears', async () => {
        // First PUT 412s, second succeeds.
        let n = 0;
        const mock = makeMockClient({ latest_snapshot_date: '2026-06-04' }, () => (n++ < 1 ? err412() : 'ok'));
        const after = await swapLatestPointer(
            mock.client, 'b',
            { latest_snapshot_date: '2026-06-05', compounds_manifest_key: 'snapshots/2026-06-05/compounds/bucket-0000/manifest.json' },
            ['latest_snapshot_date'],
        );
        expect(after.latest_snapshot_date).toBe('2026-06-05');

        const gets = mock.gets();
        const puts = mock.puts();
        // The loop re-GETs latest before each attempt: at least 2 GETs (one per
        // attempt) before the post-swap re-read GET.
        expect(gets.length).toBeGreaterThanOrEqual(3); // attempt1 GET, attempt2 GET, post-swap GET
        // Both swap PUTs carried If-Match (an existing etag was present each time).
        const swapPuts = puts;
        expect(swapPuts.length).toBe(2);
        for (const p of swapPuts) {
            expect(p.input.IfMatch).toBeDefined();
            expect(p.input.IfNoneMatch).toBeUndefined();
        }
        expect(mock.current().latest_snapshot_date).toBe('2026-06-05');
    });

    it('first-create (no prior latest) uses IfNoneMatch:* and a 412 retry STILL carries IfNoneMatch:*', async () => {
        let n = 0;
        // No initial object. Mock stores on success so the second attempt also
        // finds no object (we never store on the 412 path) -> stays first-create.
        const mock = makeMockClient(undefined, () => (n++ < 1 ? err412() : 'ok'));
        const after = await swapLatestPointer(mock.client, 'b', { latest_snapshot_date: '2026-06-05' }, ['latest_snapshot_date']);
        expect(after.latest_snapshot_date).toBe('2026-06-05');
        const puts = mock.puts();
        expect(puts.length).toBe(2);
        for (const p of puts) {
            expect(p.input.IfNoneMatch).toBe('*');
            expect(p.input.IfMatch).toBeUndefined();
        }
    });

    it('consecutive 412 beyond SWAP_MAX_RETRIES -> throws; latest content + ETag UNCHANGED', async () => {
        const prior = { latest_snapshot_date: '2026-06-04' };
        const mock = makeMockClient(prior, () => err412()); // always conflict
        const beforeEtag = mock.currentEtag();
        await expect(
            swapLatestPointer(mock.client, 'b', { latest_snapshot_date: '2026-06-05' }, ['latest_snapshot_date']),
        ).rejects.toThrow(/swap failed after \d+ attempts/);
        // Every attempt was conditional; latest never moved.
        expect(mock.puts().every(p => isConditional(p.input))).toBe(true);
        expect(mock.current()).toEqual(prior);
        expect(mock.currentEtag()).toBe(beforeEtag);
    });

    it('a genuinely unexpected (non-412, non-conditional) error is re-thrown as-is (not swallowed, not unconditional)', async () => {
        const prior = { latest_snapshot_date: '2026-06-04' };
        const weird = new Error('AccessDenied');
        weird.name = 'AccessDenied';
        weird.$metadata = { httpStatusCode: 403 };
        const mock = makeMockClient(prior, () => weird);
        await expect(
            swapLatestPointer(mock.client, 'b', { latest_snapshot_date: '2026-06-05' }, ['latest_snapshot_date']),
        ).rejects.toThrow(/AccessDenied/);
        // It is NOT wrapped as ConditionalUnsupportedError and latest is unchanged.
        expect(mock.current()).toEqual(prior);
        expect(mock.puts()).toHaveLength(1);
        expect(isConditional(mock.puts()[0].input)).toBe(true);
    });
});

describe('stage-4 swapV2Latest — ACTIVE not produced on a CAS failure (propagation)', () => {
    // swapV2Latest is the stage-4 wrapper that ACTIVATES a candidate by CAS-ing
    // latest.json via swapLatestPointer. activateValidatedCandidate calls it at
    // step 9 and only reaches postSwapActiveProbe (ACTIVE) AFTER it returns; if
    // swapV2Latest throws, ACTIVE is never produced and latest.json is unchanged.
    // We assert that propagation directly (the full activate path needs a sealed
    // candidate inventory in the mock store — out of scope for this fail-loud PR).
    it('swapV2Latest propagates the typed fatal on conditional-unsupported; latest.json UNCHANGED (candidate NOT ACTIVE)', async () => {
        const { swapV2Latest } = await import('../../scripts/factory/lib/stage-4-activate.js');
        const prior = { latest_snapshot_date: '2026-06-04' };
        const mock = makeMockClient(prior, () => errConditionalUnsupported(501));
        const identity = {
            snapshotId: '2026-06-05/run-1',
            objectPrefix: 'snapshots/2026-06-05/run-1/',
            snapshotDate: '2026-06-05',
            runId: 'run',
            runAttempt: '1',
            commitSha: 'abc123',
        };
        await expect(
            swapV2Latest({
                client: mock.client,
                bucket: 'b',
                identity,
                manifestHash: 'deadbeef',
                compoundsManifestKey: 'snapshots/2026-06-05/run-1/compounds/bucket-0000/manifest.json',
                neg: null,
                hasXref: false,
            }),
        ).rejects.toBeInstanceOf(ConditionalUnsupportedError);
        // latest.json was NOT advanced to the v2 ACTIVE pointer (still prior).
        expect(mock.current()).toEqual(prior);
        // No unconditional PUT leaked.
        expect(mock.puts().every(p => isConditional(p.input))).toBe(true);
    });
});
