// @ts-nocheck
/**
 * The observer census and the leak sentinel.
 *
 * Census: ONE fault - a latest.json contract violation - observed from all
 * THIRTEEN surfaces that can see it. Before this contract the same fault
 * reached snapshot_contract/false on four paths and unclassified/true on the
 * other nine, so a caller's retry decision depended on which door it used.
 *
 * Sentinel: the no-leak requirement was previously stated with no test behind
 * it, so every earlier test passed with the leak intact. Here the underlying
 * error's message carries snapshots/latest.json AND a unique token, and the
 * assertion is over the SERIALIZED response.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../../src/worker';

beforeAll(() => {
    if (typeof globalThis.caches === 'undefined') {
        globalThis.caches = { default: { async match() { return undefined; }, async put() { } } };
    }
});

const LATEST = 'snapshots/latest.json';
const CID = 'CID:2244';
const P = `/api/v1/compound/${CID}`;
const enc = (s) => new TextEncoder().encode(s);

const env = (b) => ({ ASSETS: { fetch: () => new Response('x') }, SCIWEON_R2: b });
const ctx = () => ({ waitUntil() { }, passThroughOnException() { } });

let seq = 0;
function corruptPointerBucket() {
    const bytes = enc('{ not json');
    const etag = `ec-${++seq}`;
    return {
        async head() { return { size: bytes.length, etag }; },
        async get() {
            return { etag, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
        },
    };
}

function throwingBucket(err) {
    return { async head() { throw err; }, async get() { throw err; } };
}

const get = (p, e) => worker.fetch(new Request(`https://x.test${p}`), e, ctx());

function rpc(alias, name, args, e) {
    const req = new Request(`https://x.test${alias}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return worker.fetch(req, e, ctx()).then(r => r.json());
}

// Surfaces 1-8: REST. The status each already returned is frozen; what the
// census fixes is that all eight now name the SAME class.
const REST_SURFACES = [
    ['bioactivities', `${P}/bioactivities`, 502],
    ['papers', `${P}/papers`, 502],
    ['trials', `${P}/trials`, 502],
    ['target', '/api/v1/target/P00533', 502],
    ['negative-evidence', `${P}/negative-evidence`, 500],
    ['repurposing-evidence', `${P}/repurposing-evidence`, 500],
    ['compound', P, 500],
    ['xrefs', '/api/v1/xrefs?id=CHEMBL25', 500],
];

// Surfaces 9-13: MCP. Carriers travel in error.data; the code is frozen.
const MCP_SURFACES = [
    ['get_target_drugs', 'sciweon_get_target_drugs', { target_id: 'P00533' }],
    ['get_negative_evidence', 'sciweon_get_negative_evidence', { cid: CID }],
    ['get_repurposing_evidence', 'sciweon_get_repurposing_evidence', { cid: CID }],
    ['resolve_entity', 'sciweon_resolve_entity', { identifier: 'CHEMBL25' }],
    ['search', 'sciweon_search', { query: 'aspirin' }],
];

describe('9b.3 - observer census: one fault, one class, thirteen surfaces', () => {
    for (const [label, path, status] of REST_SURFACES) {
        it(`REST /${label} -> ${status} snapshot_contract/false`, async () => {
            const res = await get(path, env(corruptPointerBucket()));
            expect(res.status).toBe(status);
            const body = await res.json();
            expect(body.failure_class).toBe('snapshot_contract');
            expect(body.retryable).toBe(false);
        });
    }

    for (const [label, tool, args] of MCP_SURFACES) {
        it(`MCP ${label} -> error.data snapshot_contract/false`, async () => {
            const body = await rpc('/api/mcp', tool, args, env(corruptPointerBucket()));
            expect(body.result).toBeUndefined();
            expect(body.error.data).toEqual({ failure_class: 'snapshot_contract', retryable: false });
        });
    }

    it('covers exactly thirteen surfaces', () => {
        expect(REST_SURFACES.length + MCP_SURFACES.length).toBe(13);
    });
});

describe('9b.7 - leak sentinel', () => {
    // The token is unique per run so a stale fixture cannot make this pass.
    const TOKEN = `SENT-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const LEAKY = new Error(`read of ${LATEST} failed for shard bucket-0007 ${TOKEN}`);

    function assertNoLeak(text, where) {
        expect(text.includes(TOKEN), `${where} leaked the sentinel token`).toBe(false);
        expect(text.includes(LATEST), `${where} leaked ${LATEST}`).toBe(false);
        expect(text.includes('bucket-0007'), `${where} leaked an internal key fragment`).toBe(false);
    }

    for (const [label, path] of REST_SURFACES) {
        it(`REST /${label} body carries no internal identifier`, async () => {
            const res = await get(path, env(throwingBucket(LEAKY)));
            assertNoLeak(await res.text(), `/${label}`);
        });
    }

    for (const alias of ['/api/mcp', '/api/v1/mcp']) {
        for (const [label, tool, args] of MCP_SURFACES) {
            it(`MCP ${alias} ${label}: neither error.message nor error.data leaks`, async () => {
                const body = await rpc(alias, tool, args, env(throwingBucket(LEAKY)));
                assertNoLeak(JSON.stringify(body), `${alias} ${label}`);
                if (body.error) {
                    assertNoLeak(body.error.message, `${alias} ${label} message`);
                    assertNoLeak(JSON.stringify(body.error.data ?? null), `${alias} ${label} data`);
                }
            });
        }
    }

    it('the sentinel is genuinely present in the underlying error', () => {
        // Control: without this the assertions above could pass vacuously.
        expect(LEAKY.message).toContain(TOKEN);
        expect(LEAKY.message).toContain(LATEST);
    });
});
