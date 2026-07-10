/**
 * RC-3A (D-132G) end-to-end containment tests: prove the shared source-rights
 * filter is wired at BOTH serialization boundaries on the real handlers.
 *
 * Gates: 1 (no MedDRA in REST), 2 (no MedDRA in MCP), 3 (no KEGG in REST/MCP),
 * 13 (both MCP aliases + composed routes inherit), 4/6 (withheld != absent;
 * signal preserved).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { handleXrefs } from '../../src/worker/api/xrefs';
import { handleNegativeEvidence } from '../../src/worker/api/negative-evidence';
import { handleMcp } from '../../src/worker/api/mcp';
import type { Env } from '../../src/worker';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

beforeAll(() => {
    if (typeof (globalThis as any).caches === 'undefined') {
        (globalThis as any).caches = { default: { async match() { return undefined; }, async put() {} } };
    }
});

interface MockObject { bytes: Uint8Array; etag: string; }
function makeMockBucket(store: Record<string, MockObject>) {
    return {
        async head(key: string) {
            const o = store[key];
            return o ? { size: o.bytes.length, etag: o.etag } : null;
        },
        async get(key: string) {
            const o = store[key];
            if (!o) return null;
            return {
                etag: o.etag,
                async arrayBuffer() { return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength); },
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

const MEDDRA_PT = 'ACUTE KIDNEY INJURY';
const KEGG_ID = 'D00109';

// A compound carrying a KEGG xref id (external_ids.kegg_drug_id).
const aspirin = JSON.stringify({
    id: 'sciweon::compound::CID:2244', pubchem_cid: 2244, chembl_id: 'CHEMBL25',
    inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
    external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945', kegg_drug_id: KEGG_ID, rxcui: '1191' },
});

// A faers_adr_signal NegEvidence record carrying the MedDRA PT.
const faersNeg = JSON.stringify({
    id: 'sciweon::neg::faers::CID:2244::acute_kidney_injury', evidence_type: 'faers_adr_signal',
    subject: { compound_id: 'sciweon::compound::CID:2244' },
    failure: { reason_category: 'meddra_pt_adr', reason_text: MEDDRA_PT, extraction_method: 'openfda_aggregation', extraction_confidence: 95 },
    detail: { meddra_pt: MEDDRA_PT, report_count: 15000, unii: 'R16CO5Y76E' },
    severity: 'critical', observed_date: '2026-05-16T00:00:00Z',
    confidence: { overall: 85, method: 'negative_evidence_v1' },
    provenance: { primary_source: 'openfda_faers', source_id: 'R16CO5Y76E', extraction_timestamp: '2026-05-16T00:00:00Z' },
});

// Distinct etags per fixture: the snapshot-context loader is etag-deduped
// across the isolate, so two buckets must not share a latest.json etag.
function xrefBucket() {
    return makeMockBucket({
        'snapshots/latest.json': { bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-19' })), etag: 'xref-p1' },
        'snapshots/2026-05-19/compounds-enriched.jsonl.gz': { bytes: gzipSync(aspirin), etag: 'xref-d1' },
    });
}
function negBucket() {
    return makeMockBucket({
        'snapshots/latest.json': { bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-16' })), etag: 'neg-p1' },
        'snapshots/2026-05-16/neg-evidence.jsonl.gz': { bytes: gzipSync(faersNeg), etag: 'neg-n1' },
    });
}

describe('RC-3A REST boundary - GET /api/v1/xrefs (KEGG)', () => {
    it('excludes external_ids.kegg_drug_id and stamps the kegg withheld marker', async () => {
        const req = new Request('https://sciweon.com/api/v1/xrefs?id=2244');
        const res = await handleXrefs(req, makeEnv(xrefBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain(KEGG_ID);
        const body = JSON.parse(raw);
        expect(body.xrefs.external_ids.kegg_drug_id).toBeUndefined();
        expect(body.xrefs.external_ids.unii).toBe('R16CO5Y76E');
        expect(body.source_visibility.withheld.some((m: any) => m.source_family === 'kegg')).toBe(true);
        expect(res.headers.get('x-sciweon-rights-filter')).toBe('rc3a-v1');
    });
});

describe('RC-3A REST boundary - GET /negative-evidence (MedDRA)', () => {
    it('withholds the MedDRA PT + id slug but preserves the FAERS signal', async () => {
        const req = new Request('https://sciweon.com/api/v1/compound/2244/negative-evidence');
        const res = await handleNegativeEvidence(req, makeEnv(negBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain(MEDDRA_PT);
        expect(raw).not.toContain('acute_kidney_injury');
        const body = JSON.parse(raw);
        // signal STILL present (withheld != absent).
        expect(body.negative_signals_count).toBe(1);
        expect(body.signals[0].severity).toBe('critical');
        expect(body.signals[0].detail.report_count).toBe(15000);
        expect(body.signals[0].detail.meddra_pt).toBeUndefined();
        expect(body.signals[0].source_family).toBe('meddra');
        expect(body.source_visibility.withheld.some((m: any) => m.source_family === 'meddra')).toBe(true);
        expect(res.headers.get('x-sciweon-schema-minor')).toBe('1.2');
    });
});

async function mcpNegCall(path: string) {
    const req = new Request(`https://sciweon.com${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'sciweon_get_negative_evidence', arguments: { cid: '2244' } },
        }),
    });
    return handleMcp(req, makeEnv(negBucket()), fakeCtx());
}

describe('RC-3A MCP boundary - sciweon_get_negative_evidence (both aliases)', () => {
    for (const path of ['/api/mcp', '/api/v1/mcp']) {
        it(`withholds MedDRA in the MCP tool result via ${path}`, async () => {
            const res = await mcpNegCall(path);
            expect(res.status).toBe(200);
            const env = await res.json() as any;
            const text = env.result.content[0].text as string;
            expect(text).not.toContain(MEDDRA_PT);
            expect(text).not.toContain('acute_kidney_injury');
            const payload = JSON.parse(text);
            expect(payload.negative_signals_count).toBe(1);
            expect(payload.signals[0].detail.meddra_pt).toBeUndefined();
            expect(payload.signals[0].detail.report_count).toBe(15000);
            expect(payload.source_visibility.withheld.some((m: any) => m.source_family === 'meddra')).toBe(true);
        });
    }
});
