/**
 * Tests for sciweon_get_target_drugs MCP tool (cycle 20 closeout).
 *
 * Validates: catalog registration, JSON-RPC happy path, input validation
 * errors (-32602), data layer missing (-32603), and the soft-fail
 * "resolved: false" content payload for unknown targets / missing index.
 */

import { describe, it, expect } from 'vitest';
import { handleMcp, TOOLS } from '../../src/worker/api/mcp';
import type { Env } from '../../src/worker';

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
    return { ASSETS: { fetch: () => new Response('static') } as unknown as Fetcher, SCIWEON_R2: bucket };
}

function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function utf8(s: string) { return new TextEncoder().encode(s); }
function gzipBytes(text: string): Uint8Array {
    const { gzipSync } = require('zlib');
    return new Uint8Array(gzipSync(Buffer.from(text, 'utf-8')));
}

const SNAPSHOT_DATE = '2026-05-21';

const P00533_ENTRY = {
    uniprot_accession: 'P00533',
    protein_name: 'EGFR',
    gene_symbol: 'EGFR',
    chembl_target_id: 'CHEMBL203',
    organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' },
    compound_ids: ['sciweon::compound::CID:1', 'sciweon::compound::CID:2'],
    bioactivity_ids: ['sciweon::bioactivity::1'],
    trial_ids: ['sciweon::trial::NCT:00000001'],
    negative_evidence_ids: ['sciweon::neg::bioassay::1'],
};

function makeStore(targets: Record<string, any>): Record<string, MockObject> {
    const pointer = JSON.stringify({ latest_snapshot_date: SNAPSHOT_DATE });
    const idx = JSON.stringify({ version: '0.6.0', built_at: '2026-05-21T12:00:00Z', targets });
    return {
        'snapshots/latest.json': { bytes: utf8(pointer), etag: 'etag-ptr' },
        [`snapshots/${SNAPSHOT_DATE}/target-index.json.gz`]: { bytes: gzipBytes(idx), etag: 'etag-idx' },
    };
}

async function callRpc(method: string, params: object, env: Env): Promise<any> {
    const req = new Request('https://x.test/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const res = await handleMcp(req, env, fakeCtx());
    return res.json();
}

describe('sciweon_get_target_drugs MCP tool', () => {
    it('appears in tools/list catalog', () => {
        const names = TOOLS.map(t => t.name);
        expect(names).toContain('sciweon_get_target_drugs');
        const tool = TOOLS.find(t => t.name === 'sciweon_get_target_drugs');
        expect(tool?.inputSchema.required).toEqual(['target_id']);
    });

    it('happy path: returns drug section by default', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'P00533' } }, makeEnv(bucket));
        expect(body.error).toBeUndefined();
        const payload = JSON.parse(body.result.content[0].text);
        expect(payload.resolved).toBe(true);
        expect(payload.target.uniprot_accession).toBe('P00533');
        expect(payload.target.compound_ids).toEqual(['sciweon::compound::CID:1', 'sciweon::compound::CID:2']);
        // Default include=drugs => trial_ids NOT expanded
        expect(payload.target.trial_ids).toBeUndefined();
        expect(payload.target.negative_evidence_ids).toBeUndefined();
    });

    it('include=[drugs,trials,negative_evidence] expands all sections', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'P00533', include: ['drugs', 'trials', 'negative_evidence'] } }, makeEnv(bucket));
        const payload = JSON.parse(body.result.content[0].text);
        expect(payload.target.compound_ids).toBeDefined();
        expect(payload.target.trial_ids).toEqual(['sciweon::trial::NCT:00000001']);
        expect(payload.target.negative_evidence_ids).toEqual(['sciweon::neg::bioassay::1']);
    });

    it('lowercased target_id is uppercased canonically', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'p00533' } }, makeEnv(bucket));
        const payload = JSON.parse(body.result.content[0].text);
        expect(payload.target.uniprot_accession).toBe('P00533');
    });

    it('invalid target_id returns -32602', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'not-a-uniprot' } }, makeEnv(bucket));
        expect(body.error.code).toBe(-32602);
        expect(body.error.message).toMatch(/Invalid target_id/);
    });

    it('missing target_id returns -32602', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: {} }, makeEnv(bucket));
        expect(body.error.code).toBe(-32602);
    });

    it('invalid include token returns -32602', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'P00533', include: ['bogus'] } }, makeEnv(bucket));
        expect(body.error.code).toBe(-32602);
        expect(body.error.message).toMatch(/include token/);
    });

    it('missing R2 binding returns -32603', async () => {
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'P00533' } }, makeEnv(undefined));
        expect(body.error.code).toBe(-32603);
    });

    it('unknown target returns soft {resolved:false} content, not an error', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'Q12345' } }, makeEnv(bucket));
        expect(body.error).toBeUndefined();
        const payload = JSON.parse(body.result.content[0].text);
        expect(payload.resolved).toBe(false);
        expect(payload.target_id).toBe('Q12345');
        expect(payload.snapshot_date).toBe(SNAPSHOT_DATE);
    });

    it('missing target-index.json returns soft {resolved:false} content', async () => {
        // Pointer present but index file absent — first cron after deploy
        const store: Record<string, MockObject> = {
            'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: SNAPSHOT_DATE })), etag: 'etag-ptr' },
        };
        const bucket = makeMockBucket(store);
        const body = await callRpc('tools/call', { name: 'sciweon_get_target_drugs', arguments: { target_id: 'P00533' } }, makeEnv(bucket));
        expect(body.error).toBeUndefined();
        const payload = JSON.parse(body.result.content[0].text);
        expect(payload.resolved).toBe(false);
        expect(payload.reason).toMatch(/index/i);
    });
});
