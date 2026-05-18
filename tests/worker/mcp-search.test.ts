/**
 * MCP sciweon_search tool tests — V0.5.4.
 * Verifies compound discovery via substring match over snapshot JSONL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleMcp } from '../../src/worker/api/mcp';
import type { Env } from '../../src/worker';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

interface MockObject { bytes: Uint8Array; etag: string; }

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
    return { ASSETS: { fetch: () => new Response('static') } as Fetcher, SCIWEON_R2: bucket };
}
function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
}
function mcpSearch(query: string, limit?: number): Request {
    return new Request('https://sciweon.com/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'sciweon_search', arguments: limit !== undefined ? { query, limit } : { query } },
        }),
    });
}

const ASPIRIN = JSON.stringify({
    id: 'sciweon::compound::CID:2244', pubchem_cid: 2244, chembl_id: 'CHEMBL25',
    iupac_name: '2-acetyloxybenzoic acid', synonyms: ['aspirin', 'acetylsalicylic acid'],
    molecular_formula: 'C9H8O4', molecular_weight: { value: 180.16, unit: 'Da' },
    drug_status: { max_phase: 4 }, confidence: { overall: 80 },
});
const METFORMIN = JSON.stringify({
    id: 'sciweon::compound::CID:4091', pubchem_cid: 4091, chembl_id: 'CHEMBL1431',
    iupac_name: '1,1-dimethylbiguanide', synonyms: ['metformin'],
    molecular_formula: 'C4H11N5', molecular_weight: { value: 129.16, unit: 'Da' },
    drug_status: { max_phase: 4 }, confidence: { overall: 75 },
});

describe('handleMcp — tools/call sciweon_search', () => {
    let bucket: R2Bucket;

    beforeEach(() => {
        const jsonl = [ASPIRIN, METFORMIN].join('\n');
        bucket = makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-18' })),
                etag: 'ptr-search-1',
            },
            'snapshots/2026-05-18/compounds-enriched.jsonl.gz': {
                bytes: gzipSync(jsonl),
                etag: 'compounds-search-1',
            },
        });
    });

    it('finds aspirin by exact synonym', async () => {
        const res = await handleMcp(mcpSearch('aspirin'), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error).toBeUndefined();
        const inner = JSON.parse(body.result.content[0].text);
        expect(inner.count).toBeGreaterThanOrEqual(1);
        expect(inner.results[0].pubchem_cid).toBe(2244);
    });

    it('finds aspirin by bare CID string (score 100)', async () => {
        const res = await handleMcp(mcpSearch('2244'), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        const inner = JSON.parse(body.result.content[0].text);
        expect(inner.results[0].pubchem_cid).toBe(2244);
    });

    it('finds aspirin by ChEMBL ID', async () => {
        const res = await handleMcp(mcpSearch('chembl25'), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        const inner = JSON.parse(body.result.content[0].text);
        expect(inner.results[0].chembl_id).toBe('CHEMBL25');
    });

    it('finds aspirin by molecular formula', async () => {
        const res = await handleMcp(mcpSearch('c9h8o4'), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        const inner = JSON.parse(body.result.content[0].text);
        expect(inner.results[0].pubchem_cid).toBe(2244);
    });

    it('returns empty array when no match', async () => {
        const res = await handleMcp(mcpSearch('zzz_no_such_compound'), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        const inner = JSON.parse(body.result.content[0].text);
        expect(inner.count).toBe(0);
        expect(inner.results).toHaveLength(0);
    });

    it('respects limit parameter', async () => {
        const res = await handleMcp(mcpSearch('met', 1), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        const inner = JSON.parse(body.result.content[0].text);
        expect(inner.results.length).toBeLessThanOrEqual(1);
    });

    it('rejects empty query with -32602', async () => {
        const res = await handleMcp(mcpSearch(''), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32602);
    });

    it('rejects query over 200 chars with -32602', async () => {
        const res = await handleMcp(mcpSearch('a'.repeat(201)), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        expect(body.error.code).toBe(-32602);
    });

    it('result includes drug_status and confidence_overall', async () => {
        const res = await handleMcp(mcpSearch('aspirin'), makeEnv(bucket), fakeCtx());
        const body = await res.json() as any;
        const inner = JSON.parse(body.result.content[0].text);
        const compound = inner.results[0];
        expect(compound.drug_status?.max_phase).toBe(4);
        expect(compound.confidence_overall).toBe(80);
    });
});
