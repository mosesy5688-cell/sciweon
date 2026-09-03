// @ts-nocheck
/**
 * P0.1 public error contract - per-class serialization, the exact route/class
 * membership oracle, the not-produced guard, the enumerated-file source lint.
 * Every case drives the REAL worker entry and reads the SERIALIZED body, so
 * what is asserted is what a caller receives - not an internal object.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../../src/worker';
import { FAILURE_CONTRACT, FAILURE_CLASSES } from '../../src/worker/lib/failure-contract';
import { parseCompoundId } from '../../src/worker/lib/id-parse';
import { negManifestKeyFor } from '../../src/worker/lib/neg-shard-router';
import { negBucketOf } from '../../src/lib/neg-bucket-hash.js';

beforeAll(() => {
    if (typeof globalThis.caches === 'undefined') globalThis.caches = { default: { async match() { return undefined; }, async put() { } } };
});

// A temporal or future-process term, anchored on word boundaries and full phrases:
// bare `available` / `temporar` fire on labels this lane KEEPS and on a 200-body status.
export const FORBIDDEN = [
    /\bshortly\b/i, /\bsoon\b/i, /\blater\b/i, /\bmomentarily\b/i,
    /\bin a moment\b/i, /\bin a few\b/i, /\btry again in\b/i,
    /\bcheck back\b/i, /\bcome back\b/i, /\bavailable again\b/i,
    /\brestored shortly\b/i, /\btemporarily\b/i, /\bretry-after\b/i,
    /\bnext\b[^.]{0,60}\bcron\b/i, /\bwill produce\b/i, /\bwill be available\b/i,
    /\bnot yet built\b/i, /\bonce published\b/i, /\bpending\b/i,
    /\bin progress\b/i, /\bbeing built\b/i, /\bimmediately post-deploy\b/i,
];

// VALUES only, never keys: the literal key `retryable` is retry-suggesting.
export function stringValues(node, out = []) {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) for (const v of node) stringValues(v, out);
    else if (node && typeof node === 'object') for (const v of Object.values(node)) stringValues(v, out);
    return out;
}

export function assertNoForbiddenTerm(values, where) {
    for (const v of values) for (const re of FORBIDDEN) {
        expect(re.test(v), `${where}: forbidden term ${re} in ${JSON.stringify(v)}`).toBe(false);
    }
}

let seq = 0;
const tag = () => `ct-${++seq}`;
const enc = (s) => new TextEncoder().encode(s);
const gz = (s) => new Uint8Array(require('zlib').gzipSync(Buffer.from(s, 'utf-8')));

const DATE = '2026-07-01';
const PFX = `snapshots/${DATE}/`;
const LATEST = 'snapshots/latest.json';
const CID = 'CID:2244';
const CANON = parseCompoundId(CID).canonical;
const MKEY = negManifestKeyFor(DATE, negBucketOf(CANON));
const PTR = JSON.stringify({ latest_snapshot_date: DATE });

// neg-manifest-loader keeps a per-isolate cache keyed by snapshot IDENTITY, so two
// scenarios sharing one date would share one cached manifest: each gets its own date.
function shardScenario(date, manifestJson, opts) {
    const key = negManifestKeyFor(date, negBucketOf(CANON));
    const ptr = JSON.stringify({ latest_snapshot_date: date, neg_evidence_manifest_key: key });
    const st = store([[LATEST, enc(ptr)], [key, enc(manifestJson)]]);
    return () => env(bucket(st, opts ? opts(key) : {}));
}

export function store(pairs) {
    const o = {};
    for (const [k, b] of pairs) o[k] = { bytes: b, etag: tag() };
    return o;
}

export function bucket(st, opts = {}) {
    const hit = (k) => opts.throwOn && opts.throwOn(k);
    return {
        async head(k) { if (hit(k)) throw opts.error; const o = st[k]; return o ? { size: o.bytes.length, etag: o.etag } : null; },
        async get(k) {
            if (hit(k)) throw opts.error;
            if (opts.getNull && opts.getNull(k)) return null;
            const o = st[k]; if (!o) return null; const b = o.bytes;
            return { etag: o.etag, async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
        },
    };
}

export const env = (b) => ({ ASSETS: { fetch: () => new Response('x') }, SCIWEON_R2: b });
const ctx = () => ({ waitUntil() { }, passThroughOnException() { } });
const call = (p, e) => worker.fetch(new Request(`https://x.test${p}`), e, ctx());

const P = `/api/v1/compound/${CID}`;
const ROUTES = {
    compound: P,
    neg: `${P}/negative-evidence`,
    bio: `${P}/bioactivities`,
    trials: `${P}/trials`,
    papers: `${P}/papers`,
    repurposing: `${P}/repurposing-evidence`,
    target: '/api/v1/target/P00533',
    xrefs: '/api/v1/xrefs?id=CHEMBL25',
};

const noBucket = () => env(undefined);
const corruptPtr = () => env(bucket(store([[LATEST, enc('{ not json')]])));
const ptrOnly = () => env(bucket(store([[LATEST, enc(PTR)]])));
const emptyBucket = () => env(bucket(store([])));
const corruptGz = (key) => () => env(bucket(store([[LATEST, enc(PTR)], [key, new Uint8Array([9, 8, 7, 6])]])));
const timeoutOn = (key) => () => env(bucket(store([[LATEST, enc(PTR)]]),
    { throwOn: (k) => k === key, error: new Error('R2 operation timed out') }));
const OK_LAYERS = [
    [LATEST, enc(PTR)],
    [`${PFX}bioactivities.jsonl.gz`, gz('')],
    [`${PFX}trial-links.jsonl.gz`, gz('')],
    [MKEY, enc(JSON.stringify({ bucket: 0, snapshot_date: DATE, entries: [], shard_hashes: [] }))],
];
const repurposingTimeout = () => env(bucket(store(OK_LAYERS),
    { throwOn: (k) => k === `${PFX}papers.jsonl.gz`, error: new Error('R2 operation timed out') }));
const boom = () => env(bucket(store([]), { throwOn: () => true, error: new Error('boom') }));
// head() sees the manifest, get() does not: an R2 read fault, so the cause is
// NOT a ShardDataInvalidError and the class stays retryable.
const shardRead = shardScenario('2026-07-02', '{"entries":[]}', (k) => ({ getNull: (x) => x === k }));
// entries is not an array: the shape guard types it at its source.
const shardInvalid = shardScenario('2026-07-03', '{"entries":"nope"}');
// xrefs: a VALID pointer on its own date, with the xref-index object VISIBLE to
// head() but ABSENT from get() - an R2 read fault -> R2ReadError('disappeared').
const XKEY = 'snapshots/2026-07-04/xref-index.json.gz';
const xrefGone = () => env(bucket(store([[LATEST, enc('{"latest_snapshot_date":"2026-07-04"}')], [XKEY, gz('{}')]]), { getNull: (k) => k === XKEY }));

// [class, route, status, env]. A class is exercised on every route that can
// produce it; a route/class pair the code cannot construct is not invented.
const CASES = [
    // All eight REST routes refuse identically when the binding is absent.
    ...Object.keys(ROUTES).map(r => ['data_layer_unconfigured', r, 503, noBucket]),
    // One fault, one class, thirteen surfaces - at the status each already had.
    ...Object.entries({
        compound: 500, neg: 500, bio: 502, trials: 502,
        papers: 502, repurposing: 500, target: 502, xrefs: 500,
    }).map(([r, st]) => ['snapshot_contract', r, st, corruptPtr]),
    ['source_unavailable', 'neg', 404, emptyBucket],
    ['source_unavailable', 'bio', 503, ptrOnly],
    ['source_unavailable', 'trials', 503, ptrOnly],
    ['source_unavailable', 'papers', 503, ptrOnly],
    ['source_unavailable', 'repurposing', 503, emptyBucket],
    ['source_unavailable', 'target', 503, ptrOnly],
    // compound and xrefs carry no catch of their own: the read fault reaches json500.
    ['source_unavailable', 'compound', 500, emptyBucket],
    ['source_unavailable', 'xrefs', 500, xrefGone],
    ['parse_failed', 'bio', 502, corruptGz(`${PFX}bioactivities.jsonl.gz`)],
    ['parse_failed', 'trials', 502, corruptGz(`${PFX}trial-links.jsonl.gz`)],
    ['parse_failed', 'papers', 502, corruptGz(`${PFX}papers.jsonl.gz`)],
    ['timeout', 'bio', 503, timeoutOn(`${PFX}bioactivities.jsonl.gz`)],
    ['timeout', 'trials', 503, timeoutOn(`${PFX}trial-links.jsonl.gz`)],
    ['timeout', 'papers', 503, timeoutOn(`${PFX}papers.jsonl.gz`)],
    ['timeout', 'repurposing', 503, repurposingTimeout],
    ['shard_read_unavailable', 'neg', 503, shardRead],
    ['shard_manifest_invalid', 'neg', 503, shardInvalid],
    ['unclassified', 'compound', 500, boom],
    ['unclassified', 'neg', 500, boom],
    ['unclassified', 'target', 500, boom],
];

describe('9a - the exported failure contract', () => {
    it('declares nine classes; object_integrity is the only not-produced one', () => {
        expect(FAILURE_CLASSES).toHaveLength(9);
        expect(FAILURE_CLASSES.filter(c => !FAILURE_CONTRACT[c].produced)).toEqual(['object_integrity']);
    });

    it('every default_detail is free of forbidden vocabulary', () => {
        assertNoForbiddenTerm(FAILURE_CLASSES.map(c => FAILURE_CONTRACT[c].default_detail), 'contract table');
    });
});

describe('9b.1 - per-class serialization on every route that emits the class', () => {
    for (const [cls, route, status, mkEnv] of CASES) {
        it(`${route} -> ${status} ${cls}`, async () => {
            const res = await call(ROUTES[route], mkEnv());
            expect(res.status).toBe(status);
            expect(res.headers.get('retry-after')).toBeNull();
            expect(res.headers.get('cache-control')).toBeNull();
            const body = await res.json();
            expect(body.failure_class).toBe(cls);
            expect(Object.prototype.hasOwnProperty.call(body, 'retryable')).toBe(true);
            expect(body.retryable).toBe(FAILURE_CONTRACT[cls].retryable);
            assertNoForbiddenTerm(stringValues(body), `${route}/${cls}`);
        });
    }

    it('covers every LIVE class', () => {
        const live = FAILURE_CLASSES.filter(c => FAILURE_CONTRACT[c].produced);
        expect([...new Set(CASES.map(c => c[0]))].sort()).toEqual([...live].sort());
    });

    // 9b.1a - the EXACT membership oracle. These 36 pairs are hand-written from the
    // contract table and the per-route census, deliberately NOT derived from CASES:
    // an expectation computed from the thing under test proves nothing.
    it('CASES holds exactly the 36 hand-listed route/class pairs', () => {
        const want = Object.entries({
            data_layer_unconfigured: 'compound neg bio trials papers repurposing target xrefs',
            snapshot_contract: 'compound neg bio trials papers repurposing target xrefs',
            source_unavailable: 'compound neg bio trials papers repurposing target xrefs',
            parse_failed: 'bio trials papers', timeout: 'bio trials papers repurposing',
            shard_read_unavailable: 'neg', shard_manifest_invalid: 'neg', unclassified: 'compound neg target',
        }).flatMap(([cls, routes]) => routes.split(' ').map(r => `${cls}|${r}`));
        expect(want).toHaveLength(36);
        expect(CASES.map(c => `${c[0]}|${c[1]}`).sort()).toEqual([...want].sort());
    });
});

describe('9b.2 - declared-not-produced guard', () => {
    it('no emitting path yields object_integrity', async () => {
        for (const [, route, , mkEnv] of CASES) {
            expect((await (await call(ROUTES[route], mkEnv())).json()).failure_class).not.toBe('object_integrity');
        }
    });
});

// 9b.8 - an ENUMERATED file list, never a directory walk. src/worker/api/health.ts does not exist at this base.
const LINTED = [
    'src/worker.ts',
    ...['bioactivities', 'compound', 'mcp', 'negative-evidence', 'papers',
        'repurposing-evidence', 'target', 'trials', 'xrefs'].map(f => `src/worker/api/${f}.ts`),
    ...['failure-contract', 'mcp-handlers', 'mcp-tools', 'neg-shard-error',
        'source-load-error'].map(f => `src/worker/lib/${f}.ts`),
];
const LIT = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

export function literalsOutsideThrow(src) {
    const out = [];
    let inThrow = false;
    for (const raw of src.split('\n')) {
        const line = raw.trim();
        if (!inThrow && /\bthrow\s/.test(line)) inThrow = true;
        const skip = inThrow;
        if (inThrow && line.endsWith(';')) inThrow = false;
        if (skip || line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
        for (const m of line.matchAll(LIT)) out.push(m[1] ?? m[2] ?? m[3]);
    }
    return out;
}

describe('9b.8 - enumerated-file source lint', () => {
    for (const rel of LINTED) {
        it(`${rel} carries no forbidden vocabulary in a string literal`, () => {
            const src = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
            assertNoForbiddenTerm(literalsOutsideThrow(src), rel);
        });
    }
});
