// @ts-nocheck
/**
 * RK-15 V2 test fixtures — a mock S3 client that EMULATES R2 conditional PUTs
 * (IfNoneMatch:'*' -> 412 on existing key; IfMatch CAS), plus mis-behaving
 * variants used to PROVE the harness gates actually catch a non-enforcing store.
 * (True R2 conditional honoring can only be confirmed live — that is the
 * workflow's job; these tests lock the CONTROL LOGIC.)
 */

export const PROD_LATEST_KEY = 'snapshots/latest.json';

/**
 * opts:
 *   ignoreCreateOnly  — accept IfNoneMatch:'*' even when the key exists (proves
 *                       the collision-gate / B-touches-A gate FAILS loudly).
 *   ignoreIfMatch     — accept any IfMatch (proves the stale-CAS gate FAILS).
 *   mutateProdLatest  — flip production latest.json mid-run (proves the
 *                       prod-invariance gate FAILS).
 */
export function makeR2Mock(opts: any = {}) {
    const store = new Map<string, { body: any; etag: string }>();
    let seq = 0;
    let mutated = false;
    return {
        store,
        seed(key: string, body: any) { store.set(key, { body, etag: `"seed-${++seq}"` }); },
        async send(cmd: any) {
            const name = cmd.constructor.name;
            const { Key } = cmd.input;
            if (name === 'GetObjectCommand') {
                // Optionally mutate production latest exactly once, after the first read.
                if (opts.mutateProdLatest && Key === PROD_LATEST_KEY && !mutated && store.has(Key)) {
                    mutated = true;
                    // Defer the mutation until AFTER returning the first (before) read.
                    const cur = store.get(Key)!;
                    queueMicrotask(() => store.set(Key, { body: cur.body + ' ', etag: `"mutated-${++seq}"` }));
                }
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const buf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
                async function* gen() { yield buf; }
                return { ETag: o.etag, Body: gen() };
            }
            if (name === 'HeadObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const len = Buffer.isBuffer(o.body) ? o.body.length : Buffer.byteLength(o.body);
                return { ETag: o.etag, ContentLength: len };
            }
            // PutObjectCommand
            const exists = store.get(Key);
            if (cmd.input.IfNoneMatch === '*' && exists && !opts.ignoreCreateOnly) {
                const e: any = new Error('At least one precondition failed: PreconditionFailed');
                e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            if (cmd.input.IfMatch !== undefined && !opts.ignoreIfMatch && (!exists || exists.etag !== cmd.input.IfMatch)) {
                const e: any = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            store.set(Key, { body: cmd.input.Body, etag: `"e-${++seq}"` });
            return {};
        },
    };
}

/** A production-latest seed so the before/after invariance check has an object. */
export function seedProdLatest(mock: any, date = '2026-06-01') {
    mock.seed(PROD_LATEST_KEY, JSON.stringify({ latest_snapshot_date: date }));
}
