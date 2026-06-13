// @ts-nocheck
/**
 * RK-15 V1 ★ — unit tests for the real-R2 verification harness PURE LOGIC.
 *
 * These tests do NOT hit real R2. They drive `runHarness` (the harness's
 * orchestrator) with a MOCK S3 client and assert:
 *   - an ENFORCING store -> v1_pass=true (positive controls all green);
 *   - a store that IGNORES IfNoneMatch (2nd create-only overwrites) -> the
 *     create-only collision check FAILS (proves the harness catches a
 *     non-enforcing store — the single most important property);
 *   - a store that IGNORES IfMatch (wrong-ETag CAS succeeds) -> the CAS check FAILS;
 *   - a store where a PUT is issued WITHOUT a conditional header (injected) ->
 *     the no-unconditional-PUT check FAILS;
 *   - production latest.json changing between before/after -> FAIL.
 *
 * The mock mirrors R2 semantics: PutObjectCommand with IfNoneMatch:'*' against an
 * existing key -> 412 PreconditionFailed; with IfMatch != current ETag -> 412.
 */

import { describe, it, expect } from 'vitest';
import { runHarness, summarizePutConditionals } from '../../scripts/verify/rk15-v1-verify.js';

import { createHash } from 'crypto';

const BUCKET = 'test-bucket';

function etagOf(buf: Buffer): string {
    // R2/S3 etags are quoted md5-ish hex; for the mock we use a quoted sha1 slice.
    return '"' + createHash('sha1').update(buf).digest('hex') + '"';
}

function toBuf(body: any): Buffer {
    if (body == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    return Buffer.from(body);
}

function precondFailed() {
    const err: any = new Error('At least one of the pre-conditions you specified did not hold');
    err.name = 'PreconditionFailed';
    err.$metadata = { httpStatusCode: 412 };
    return err;
}

function noSuchKey() {
    const err: any = new Error('The specified key does not exist.');
    err.name = 'NoSuchKey';
    err.$metadata = { httpStatusCode: 404 };
    return err;
}

/**
 * Build a mock S3 client backed by an in-memory store.
 * opts:
 *   ignoreIfNoneMatch  — accept create-only PUTs even when the key exists (overwrite)
 *   ignoreIfMatch      — accept CAS PUTs regardless of the supplied IfMatch
 *   stripConditionals  — drop IfNoneMatch/IfMatch before applying (issues an
 *                        effectively-unconditional PUT, but the *recorded* command
 *                        still shows whatever the caller set — so to exercise the
 *                        no-unconditional-PUT check we instead inject a raw PUT below)
 *   prodLatest         — initial body for snapshots/latest.json (or null = absent)
 *   mutateProdOnPut    — if set, mutates prod latest on the first namespaced PUT
 */
function makeMockClient(opts: any = {}) {
    const store = new Map<string, Buffer>(); // key -> body
    if (opts.prodLatest != null) {
        store.set('snapshots/latest.json', toBuf(opts.prodLatest));
    }
    let mutated = false;

    const client: any = {
        store,
        async send(command: any) {
            const ctor = command?.constructor?.name;
            const input = command?.input ?? {};
            const key = input.Key;

            if (ctor === 'GetObjectCommand') {
                if (!store.has(key)) throw noSuchKey();
                const body = store.get(key)!;
                return { ETag: etagOf(body), Body: body };
            }
            if (ctor === 'HeadObjectCommand') {
                if (!store.has(key)) throw noSuchKey();
                return { ETag: etagOf(store.get(key)!) };
            }
            if (ctor === 'PutObjectCommand') {
                const body = toBuf(input.Body);
                const exists = store.has(key);

                // create-only semantics
                if (input.IfNoneMatch === '*') {
                    if (exists && !opts.ignoreIfNoneMatch) throw precondFailed();
                    // (ignoreIfNoneMatch -> fall through and OVERWRITE)
                }
                // CAS semantics
                if (input.IfMatch != null) {
                    const cur = exists ? etagOf(store.get(key)!) : null;
                    if (input.IfMatch !== cur && !opts.ignoreIfMatch) throw precondFailed();
                }

                store.set(key, body);

                // Optional: simulate a buggy wrapper mutating prod latest.
                if (opts.mutateProdOnPut && !mutated && key.startsWith('rk15-verification/')) {
                    mutated = true;
                    store.set('snapshots/latest.json', toBuf('MUTATED ' + Date.now()));
                }
                return { ETag: etagOf(body) };
            }
            throw new Error('mock: unsupported command ' + ctor);
        },
    };
    return client;
}

describe('rk15-v1-verify harness — pure logic', () => {
    it('ENFORCING store -> v1_pass=true (all positive + negative controls green)', async () => {
        const client = makeMockClient({ prodLatest: JSON.stringify({ latest_snapshot_date: '2026-06-13' }) });
        const report = await runHarness(client, BUCKET, { runId: 'unit-enforcing', commitSha: 'deadbeef' });

        expect(report.v1_pass).toBe(true);
        expect(report.checks.create_only_first_put.pass).toBe(true);
        expect(report.checks.create_only_collision_rejected.pass).toBe(true);
        expect(report.checks.cas_correct_etag_succeeds.pass).toBe(true);
        expect(report.checks.cas_wrong_etag_rejected.pass).toBe(true);
        expect(report.checks.no_unconditional_put.pass).toBe(true);
        expect(report.checks.prod_latest_before.pass).toBe(true);
        expect(report.checks.prod_latest_after.pass).toBe(true);
        // collision left the object byte-identical
        expect(report.checks.create_only_collision_rejected.objectUnchanged).toBe(true);
    });

    it('works when production latest.json is ABSENT (records absent, stays absent)', async () => {
        const client = makeMockClient({ prodLatest: null });
        const report = await runHarness(client, BUCKET, { runId: 'unit-no-prod' });
        expect(report.checks.prod_latest_before.present).toBe(false);
        expect(report.v1_pass).toBe(true);
    });

    it('store that IGNORES IfNoneMatch -> create-only collision check FAILS', async () => {
        const client = makeMockClient({ ignoreIfNoneMatch: true });
        const report = await runHarness(client, BUCKET, { runId: 'unit-ignore-inm' });

        expect(report.checks.create_only_collision_rejected.pass).toBe(false);
        expect(report.checks.create_only_collision_rejected.reason).toMatch(/did NOT enforce|SUCCEEDED/i);
        expect(report.v1_pass).toBe(false);
    });

    it('store that IGNORES IfMatch -> wrong-ETag CAS check FAILS', async () => {
        const client = makeMockClient({ ignoreIfMatch: true });
        const report = await runHarness(client, BUCKET, { runId: 'unit-ignore-im' });

        expect(report.checks.cas_wrong_etag_rejected.pass).toBe(false);
        expect(report.checks.cas_wrong_etag_rejected.reason).toMatch(/did NOT enforce|SUCCEEDED/i);
        expect(report.v1_pass).toBe(false);
    });

    it('a PUT issued WITHOUT a conditional header -> no-unconditional-PUT check FAILS', async () => {
        // The __injectUnconditionalPut test seam makes the producer issue ONE
        // unconditional PUT through the SAME instrumented client the harness uses,
        // so we prove the send-log audit CATCHES a degraded (unconditional) write.
        const client = makeMockClient({});
        const report = await runHarness(client, BUCKET, {
            runId: 'unit-uncond',
            __injectUnconditionalPut: true,
        });

        expect(report.checks.no_unconditional_put.pass).toBe(false);
        expect(report.put_conditional_summary.unconditionalPutCount).toBeGreaterThanOrEqual(1);
        expect(report.checks.no_unconditional_put.reason).toMatch(/unconditional/i);
        expect(report.v1_pass).toBe(false);
    });

    it('production latest.json changing between before/after -> prod_latest_after FAILS', async () => {
        const client = makeMockClient({
            prodLatest: JSON.stringify({ latest_snapshot_date: '2026-06-13' }),
            mutateProdOnPut: true,
        });
        const report = await runHarness(client, BUCKET, { runId: 'unit-prod-mutate' });

        expect(report.checks.prod_latest_after.pass).toBe(false);
        expect(report.checks.prod_latest_after.reason).toMatch(/CHANGED/i);
        expect(report.v1_pass).toBe(false);
    });

    it('summarizePutConditionals counts conditional vs unconditional PUTs', () => {
        const log = [
            { command: 'PutObjectCommand', key: 'a', put: { ifNoneMatch: '*', ifMatch: null, conditional: true } },
            { command: 'PutObjectCommand', key: 'b', put: { ifNoneMatch: null, ifMatch: '"x"', conditional: true } },
            { command: 'PutObjectCommand', key: 'c', put: { ifNoneMatch: null, ifMatch: null, conditional: false } },
            { command: 'GetObjectCommand', key: 'd' },
        ];
        const s = summarizePutConditionals(log as any);
        expect(s.putCount).toBe(3);
        expect(s.conditionalPutCount).toBe(2);
        expect(s.unconditionalPutCount).toBe(1);
        expect(s.unconditionalKeys).toEqual(['c']);
        expect(s.ifNoneMatchCount).toBe(1);
        expect(s.ifMatchCount).toBe(1);
    });
});
