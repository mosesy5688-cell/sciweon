// @ts-nocheck
/**
 * MCP failure carriers - the JSON-RPC half of the P0.1 error contract.
 *
 * The envelope is {code, message, data?}: failure_class and retryable travel
 * in error.data and the message carries prose only. Three surfaces are checked
 * over their ACTUAL serialized payloads, because they serialize differently:
 * the error object, the tool-result JSON string inside content[0].text, and
 * tools/list, which returns {tools} through jsonrpcResult and is reachable by
 * neither of the other two.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../../src/worker';
import { parseCompoundId } from '../../src/worker/lib/id-parse';
import { negManifestKeyFor } from '../../src/worker/lib/neg-shard-router';
import { negBucketOf } from '../../src/lib/neg-bucket-hash.js';

beforeAll(() => {
    if (typeof globalThis.caches === 'undefined') {
        globalThis.caches = { default: { async match() { return undefined; }, async put() { } } };
    }
});

const FORBIDDEN = [
    /\bshortly\b/i, /\bsoon\b/i, /\blater\b/i, /\bmomentarily\b/i, /\bin a moment\b/i,
    /\bin a few\b/i, /\btry again in\b/i, /\bcheck back\b/i, /\bcome back\b/i,
    /\bavailable again\b/i, /\brestored shortly\b/i, /\btemporarily\b/i, /\bretry-after\b/i,
    /\bnext\b[^.]{0,60}\bcron\b/i, /\bwill produce\b/i, /\bwill be available\b/i,
    /\bnot yet built\b/i, /\bonce published\b/i, /\bpending\b/i, /\bin progress\b/i,
    /\bbeing built\b/i, /\bimmediately post-deploy\b/i,
];

// VALUES only, never keys: the literal key `retryable` is retry-suggesting.
function strings(node, out = []) {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) for (const v of node) strings(v, out);
    else if (node && typeof node === 'object') for (const v of Object.values(node)) strings(v, out);
    return out;
}

function noForbidden(values, where) {
    for (const v of values) {
        for (const re of FORBIDDEN) {
            expect(re.test(v), `${where}: forbidden term ${re} in ${JSON.stringify(v)}`).toBe(false);
        }
    }
}

let seq = 0;
const enc = (s) => new TextEncoder().encode(s);
const gz = (s) => new Uint8Array(require('zlib').gzipSync(Buffer.from(s, 'utf-8')));
const LATEST = 'snapshots/latest.json';
const CID = 'CID:2244';
const CANON = parseCompoundId(CID).canonical;

function store(pairs) {
    const o = {};
    for (const [k, b] of pairs) o[k] = { bytes: b, etag: `mc-${++seq}` };
    return o;
}

function bucket(st, opts = {}) {
    const hit = (k) => opts.throwOn && opts.throwOn(k);
    return {
        async head(k) {
            if (hit(k)) throw opts.error;
            const o = st[k];
            return o ? { size: o.bytes.length, etag: o.etag } : null;
        },
        async get(k) {
            if (hit(k)) throw opts.error;
            if (opts.getNull && opts.getNull(k)) return null;
            const o = st[k];
            if (!o) return null;
            const b = o.bytes;
            return { etag: o.etag, async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
        },
    };
}

const env = (b) => ({ ASSETS: { fetch: () => new Response('x') }, SCIWEON_R2: b });
const ctx = () => ({ waitUntil() { }, passThroughOnException() { } });

async function rpc(alias, method, params, e) {
    const req = new Request(`https://x.test${alias}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await worker.fetch(req, e, ctx())).json();
}

const callTool = (alias, name, args, e) => rpc(alias, 'tools/call', { name, arguments: args }, e);

// Per-isolate manifest caching is keyed by snapshot identity, so each sharded
// scenario takes its own date.
function shardEnv(date, manifestJson, opts) {
    const key = negManifestKeyFor(date, negBucketOf(CANON));
    const ptr = JSON.stringify({ latest_snapshot_date: date, neg_evidence_manifest_key: key });
    return env(bucket(store([[LATEST, enc(ptr)], [key, enc(manifestJson)]]), opts ? opts(key) : {}));
}

const DATE = '2026-08-01';
const idx = (targets) => JSON.stringify({ version: '0.6.0', built_at: '', targets });
const ptrOnly = () => env(bucket(store([[LATEST, enc(JSON.stringify({ latest_snapshot_date: DATE }))]])));
const withIndex = (targets) => env(bucket(store([
    [LATEST, enc(JSON.stringify({ latest_snapshot_date: DATE }))],
    [`snapshots/${DATE}/target-index.json.gz`, gz(idx(targets))],
])));
const corruptPtr = () => env(bucket(store([[LATEST, enc('{ not json')]])));
const boom = () => env(bucket(store([]), { throwOn: () => true, error: new Error('boom') }));

const NEG = 'sciweon_get_negative_evidence';
const TGT = 'sciweon_get_target_drugs';
const REP = 'sciweon_get_repurposing_evidence';

// [label, tool, args, env, code, data]
const ERROR_CASES = [
    ['binding absent', NEG, { cid: CID }, () => env(undefined), -32603,
        { failure_class: 'data_layer_unconfigured', retryable: false }],
    ['sharded read fault', NEG, { cid: CID },
        () => shardEnv('2026-08-02', '{"entries":[]}', (k) => ({ getNull: (x) => x === k })), -32000,
        { failure_class: 'shard_read_unavailable', retryable: true }],
    ['manifest shape fault', NEG, { cid: CID },
        () => shardEnv('2026-08-03', '{"entries":"nope"}'), -32000,
        { failure_class: 'shard_manifest_invalid', retryable: false }],
    ['aggregator source failure', REP, { cid: CID }, () => env(bucket(store([]))), -32000,
        { failure_class: 'source_unavailable', retryable: true, source: 'snapshot-pointer' }],
    ['target index unreadable', TGT, { target_id: 'P00533' }, ptrOnly, -32000,
        { failure_class: 'source_unavailable', retryable: true }],
    ['snapshot contract violation', TGT, { target_id: 'P00533' }, corruptPtr, -32603,
        { failure_class: 'snapshot_contract', retryable: false }],
    ['unexpected internal fault', TGT, { target_id: 'P00533' }, boom, -32603,
        { failure_class: 'unclassified', retryable: true }],
];

describe('9b.4 - MCP error parity over the full serialized error object', () => {
    for (const alias of ['/api/mcp', '/api/v1/mcp']) {
        for (const [label, tool, args, mkEnv, code, data] of ERROR_CASES) {
            it(`${alias} ${tool}: ${label}`, async () => {
                const body = await callTool(alias, tool, args, mkEnv());
                expect(body.result).toBeUndefined();
                expect(body.error.code).toBe(code);
                expect(typeof body.error.message).toBe('string');
                expect(body.error.data).toEqual(data);
                noForbidden(strings(body.error), `${alias} ${label}`);
            });
        }
    }

    it('invalid params carries NO carriers - client input is out of scope', async () => {
        const body = await callTool('/api/mcp', TGT, { target_id: 'not-a-uniprot' }, withIndex({}));
        expect(body.error.code).toBe(-32602);
        expect(body.error.data).toBeUndefined();
    });
});

describe('9b.5 - MCP tool-result payloads (a JSON string in content[0].text)', () => {
    it('a target genuinely absent from the index stays a clean resolved:false', async () => {
        const body = await callTool('/api/mcp', TGT, { target_id: 'Q12345' }, withIndex({ P00533: {
            uniprot_accession: 'P00533', protein_name: 'EGFR', gene_symbol: 'EGFR',
            chembl_target_id: 'CHEMBL203', organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' },
            compound_ids: [], bioactivity_ids: [], trial_ids: [], negative_evidence_ids: [],
        } }));
        expect(body.error).toBeUndefined();
        const payload = JSON.parse(body.result.content[0].text);
        expect(payload.resolved).toBe(false);
        noForbidden(strings(payload), 'target absent payload');
    });

    it('the rights-withheld resolve_entity payload is free of forbidden vocabulary', async () => {
        const body = await callTool('/api/mcp', 'sciweon_resolve_entity', { identifier: 'KEGG:D00109' }, ptrOnly());
        const payload = JSON.parse(body.result.content[0].text);
        expect(payload.resolution_state).toBe('withheld_by_rights_policy');
        noForbidden(strings(payload), 'rights payload');
    });
});

describe('9b.6 - the actual tools/list payload', () => {
    it('every string in result.tools[] is free of forbidden vocabulary', async () => {
        const body = await rpc('/api/mcp', 'tools/list', {}, ptrOnly());
        expect(Array.isArray(body.result.tools)).toBe(true);
        expect(body.result.tools.length).toBeGreaterThan(0);
        // Walks descriptions AND every inputSchema description: tools/list goes
        // out through jsonrpcResult, so neither the error nor the tool-result
        // scan above can reach it.
        const values = strings(body.result.tools);
        expect(values.some(v => v.includes('UniProt'))).toBe(true);
        noForbidden(values, 'tools/list');
    });
});
