/**
 * MCP server contract tests — V0.5.4 (Sprint 1b.2).
 * JSON-RPC 2.0 protocol + sciweon_get_negative_evidence tool wiring.
 * Coverage: HTTP method semantics, envelope validation, initialize,
 * tools/list, tools/call (happy + error paths), notifications.
 * sciweon_search tests live in mcp-search.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleMcp } from '../../src/worker/api/mcp';
import type { Env } from '../../src/worker';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

interface MockObject {
    bytes: Uint8Array;
    etag: string;
}

function makeMockBucket(store: Record<string, MockObject>) {
    return {
        async head(key: string) {
            const o = store[key];
            if (!o) return null;
            return { size: o.bytes.length, etag: o.etag };
        },
        async get(key: string) {
            const o = store[key];
            if (!o) return null;
            return {
                etag: o.etag,
                async arrayBuffer() {
                    return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength);
                },
            };
        },
    } as unknown as R2Bucket;
}

function makeEnv(bucket?: R2Bucket): Env {
    return {
        ASSETS: { fetch: () => new Response('static') } as Fetcher,
        SCIWEON_R2: bucket,
    };
}

function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
}

function mcpRequest(body: object | string): Request {
    return new Request('https://sciweon.com/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('handleMcp — HTTP method semantics', () => {
    it('OPTIONS returns 204 with CORS headers', async () => {
        const req = new Request('https://sciweon.com/api/mcp', { method: 'OPTIONS' });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    });

    it('GET returns 405', async () => {
        const req = new Request('https://sciweon.com/api/mcp', { method: 'GET' });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        expect(res.status).toBe(405);
    });
});

describe('handleMcp — JSON-RPC envelope', () => {
    it('malformed JSON returns -32700 parse error', async () => {
        const req = mcpRequest('not-json');
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32700);
    });

    it('missing jsonrpc field returns -32600', async () => {
        const req = mcpRequest({ method: 'initialize', id: 1 });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32600);
    });

    it('missing method returns -32600', async () => {
        const req = mcpRequest({ jsonrpc: '2.0', id: 1 });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32600);
    });

    it('unknown method returns -32601', async () => {
        const req = mcpRequest({ jsonrpc: '2.0', id: 1, method: 'foo/bar' });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32601);
    });
});

describe('handleMcp — initialize', () => {
    it('returns protocolVersion + serverInfo + capabilities', async () => {
        const req = mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        const body = await res.json() as any;
        expect(body.jsonrpc).toBe('2.0');
        expect(body.id).toBe(1);
        expect(body.result.protocolVersion).toBe('2025-03-26');
        expect(body.result.serverInfo.name).toBe('sciweon');
        expect(body.result.serverInfo.version).toMatch(/^\d/);
        expect(body.result.capabilities.tools).toBeDefined();
    });
});

describe('handleMcp — tools/list', () => {
    it('returns the 5-tool V0.6 catalog (search, neg-evidence, resolve-entity, repurposing, target-drugs)', async () => {
        const req = mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        const body = await res.json() as any;
        expect(body.result.tools).toHaveLength(5);
        const names = (body.result.tools as any[]).map((t: any) => t.name);
        expect(names).toContain('sciweon_search');
        expect(names).toContain('sciweon_get_negative_evidence');
        expect(names).toContain('sciweon_resolve_entity');
        expect(names).toContain('sciweon_get_repurposing_evidence');
        expect(names).toContain('sciweon_get_target_drugs');
        const neg = (body.result.tools as any[]).find((t: any) => t.name === 'sciweon_get_negative_evidence');
        expect(neg.inputSchema.required).toContain('cid');
        const search = (body.result.tools as any[]).find((t: any) => t.name === 'sciweon_search');
        expect(search.inputSchema.required).toContain('query');
        const resolve = (body.result.tools as any[]).find((t: any) => t.name === 'sciweon_resolve_entity');
        expect(resolve.inputSchema.required).toContain('identifier');
        const repurp = (body.result.tools as any[]).find((t: any) => t.name === 'sciweon_get_repurposing_evidence');
        expect(repurp.inputSchema.required).toContain('cid');
        expect((body.result.tools as any[]).find((t: any) => t.name === 'sciweon_get_target_drugs').inputSchema.required).toContain('target_id');
    });
});

describe('handleMcp — tools/call sciweon_get_negative_evidence', () => {
    let bucket: R2Bucket;

    beforeEach(() => {
        const jsonl = [
            JSON.stringify({
                id: 'sciweon::neg::trial_failure::NCT04123456',
                evidence_type: 'trial_failure',
                subject: { compound_id: 'sciweon::compound::CID:2244' },
                severity: 'major',
                observed_date: '2026-05-15T03:25:00Z',
                confidence: { overall: 85 },
                provenance: { primary_source: 'clinicaltrials_gov', source_id: 'NCT04123456' },
            }),
        ].join('\n');
        bucket = makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-16' })),
                etag: 'pointer-1',
            },
            'snapshots/2026-05-16/neg-evidence.jsonl.gz': {
                bytes: gzipSync(jsonl),
                etag: 'neg-1',
            },
        });
    });

    it('happy path returns content[0].text with full JSON payload', async () => {
        const req = mcpRequest({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'sciweon_get_negative_evidence', arguments: { cid: '2244' } },
        });
        const res = await handleMcp(req, makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error).toBeUndefined();
        expect(body.result.content).toHaveLength(1);
        expect(body.result.content[0].type).toBe('text');
        const inner = JSON.parse(body.result.content[0].text);
        expect(inner.compound.id).toBe('sciweon::compound::CID:2244');
        expect(inner.negative_signals_count).toBe(1);
        expect(inner.verdict.highest_severity).toBe('major');
    });

    it('accepts canonical full ID', async () => {
        const req = mcpRequest({
            jsonrpc: '2.0',
            id: 8,
            method: 'tools/call',
            params: { name: 'sciweon_get_negative_evidence', arguments: { cid: 'sciweon::compound::CID:2244' } },
        });
        const res = await handleMcp(req, makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error).toBeUndefined();
        expect(body.result.content[0].text).toContain('sciweon::compound::CID:2244');
    });

    it('rejects malformed cid with -32602', async () => {
        const req = mcpRequest({
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: { name: 'sciweon_get_negative_evidence', arguments: { cid: 'not-a-cid' } },
        });
        const res = await handleMcp(req, makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32602);
        expect(body.error.message).toContain('Invalid compound ID');
    });

    it('missing cid arg returns -32602', async () => {
        const req = mcpRequest({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: { name: 'sciweon_get_negative_evidence', arguments: {} },
        });
        const res = await handleMcp(req, makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32602);
    });

    it('unknown tool returns -32601', async () => {
        const req = mcpRequest({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: { name: 'sciweon_does_not_exist', arguments: {} },
        });
        const res = await handleMcp(req, makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32601);
    });
});

describe('handleMcp — notifications', () => {
    it('notifications/initialized returns 204 no body', async () => {
        const req = mcpRequest({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        });
        const res = await handleMcp(req, makeEnv(), fakeCtx());
        expect(res.status).toBe(204);
    });
});
