/**
 * RC-3A (D-132G) end-to-end containment tests (corrected per founder audit):
 * OUTPUT filter wired at BOTH boundaries (REST + MCP) AND the INPUT-side KEGG
 * resolution-oracle gate on /api/v1/xrefs + MCP sciweon_resolve_entity.
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
        async head(key: string) { const o = store[key]; return o ? { size: o.bytes.length, etag: o.etag } : null; },
        async get(key: string) {
            const o = store[key];
            if (!o) return null;
            return { etag: o.etag, async arrayBuffer() { return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength); } };
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

const aspirin = JSON.stringify({
    id: 'sciweon::compound::CID:2244', pubchem_cid: 2244, chembl_id: 'CHEMBL25',
    inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
    external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945', kegg_drug_id: KEGG_ID, rxcui: '1191' },
});
const faersNeg = JSON.stringify({
    id: 'sciweon::neg::faers::CID:2244::acute_kidney_injury', evidence_type: 'faers_adr_signal',
    subject: { compound_id: 'sciweon::compound::CID:2244' },
    failure: { reason_category: 'meddra_pt_adr', reason_text: MEDDRA_PT, extraction_method: 'openfda_aggregation', extraction_confidence: 95 },
    detail: { meddra_pt: MEDDRA_PT, report_count: 15000, unii: 'R16CO5Y76E' },
    severity: 'critical', observed_date: '2026-05-16T00:00:00Z',
    confidence: { overall: 85, method: 'negative_evidence_v1' },
    provenance: { primary_source: 'openfda_faers', source_id: 'R16CO5Y76E', extraction_timestamp: '2026-05-16T00:00:00Z' },
});

// Distinct etags per fixture (the snapshot-context loader is etag-deduped).
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

describe('RC-3A REST output - xrefs KEGG containment (CID input)', () => {
    it('id=2244 resolves but external_ids.kegg_drug_id is withheld', async () => {
        const res = await handleXrefs(new Request('https://sciweon.com/api/v1/xrefs?id=2244'), makeEnv(xrefBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain(KEGG_ID);
        const body = JSON.parse(raw);
        expect(body.xrefs.external_ids.kegg_drug_id).toBeUndefined();
        expect(body.xrefs.external_ids.unii).toBe('R16CO5Y76E');
        expect(body.source_visibility.withheld.some((m: any) => m.source_family === 'kegg')).toBe(true);
    });
});

describe('RC-3A INPUT gate - xrefs KEGG resolution oracle (403)', () => {
    for (const id of ['D00109', 'KEGG:D00109']) {
        it(`?id=${id} -> 403 rights-policy, no canonical mapping, not 404`, async () => {
            const res = await handleXrefs(new Request(`https://sciweon.com/api/v1/xrefs?id=${encodeURIComponent(id)}`), makeEnv(xrefBucket()), fakeCtx());
            expect(res.status).toBe(403);
            const body = await res.json() as any;
            expect(body.resolution_state).toBe('withheld_by_rights_policy');
            expect(body.source_family).toBe('kegg');
            expect(body.canonical_id).toBeUndefined();
            expect(body.cid).toBeUndefined();
            expect(body.matched_on).toBeUndefined();
            expect(body.resolved).toBeUndefined();
        });
    }
    it('KEGG input gate is a policy decision, not a source failure (403 without R2, not 503)', async () => {
        const res = await handleXrefs(new Request('https://sciweon.com/api/v1/xrefs?id=D00109'), makeEnv(undefined), fakeCtx());
        expect(res.status).toBe(403);
    });
    it('a non-KEGG identifier still resolves normally', async () => {
        const res = await handleXrefs(new Request('https://sciweon.com/api/v1/xrefs?id=DB00945'), makeEnv(xrefBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.resolved).toBe(true);
        expect(body.matched_on).toBe('drugbank_id');
    });
});

describe('RC-3A REST output - negative-evidence MedDRA (deleted, not tokenized)', () => {
    it('deletes the MedDRA PT + faers id/url; preserves the FAERS signal', async () => {
        const res = await handleNegativeEvidence(new Request('https://sciweon.com/api/v1/compound/2244/negative-evidence'), makeEnv(negBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain(MEDDRA_PT);
        expect(raw).not.toContain('acute_kidney_injury');
        expect(raw).not.toContain('rwh_');
        const body = JSON.parse(raw);
        expect(body.negative_signals_count).toBe(1);
        expect(body.signals[0].id).toBeUndefined();
        expect(body.signals[0].url).toBeUndefined();
        expect(body.signals[0].id_visibility.source_family).toBe('meddra');
        expect(body.signals[0].severity).toBe('critical');
        expect(body.signals[0].detail.report_count).toBe(15000);
        expect(body.source_visibility.withheld.some((m: any) => m.source_family === 'meddra')).toBe(true);
    });
    it('error paths are unchanged (malformed id -> 400)', async () => {
        const res = await handleNegativeEvidence(new Request('https://sciweon.com/api/v1/compound/not-an-id/negative-evidence'), makeEnv(negBucket()), fakeCtx());
        expect(res.status).toBe(400);
    });
});

function mcpCall(path: string, params: object) {
    const req = new Request(`https://sciweon.com${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
    });
    return handleMcp(req, makeEnv(negBucket()), fakeCtx());
}
async function mcpResultPayload(res: Response) {
    const env = await res.json() as any;
    return JSON.parse(env.result.content[0].text as string);
}

describe('RC-3A MCP boundary - both aliases', () => {
    for (const path of ['/api/mcp', '/api/v1/mcp']) {
        it(`resolve_entity D00109 -> rights-policy (no mapping) via ${path}`, async () => {
            const res = await mcpCall(path, { name: 'sciweon_resolve_entity', arguments: { identifier: 'D00109' } });
            const payload = await mcpResultPayload(res);
            expect(payload.resolution_state).toBe('withheld_by_rights_policy');
            expect(payload.source_family).toBe('kegg');
            expect(payload.canonical_id).toBeUndefined();
            expect(payload.cid).toBeUndefined();
            expect(payload.matched_on).toBeUndefined();
            expect(payload.resolved).toBeUndefined();
        });
        it(`get_negative_evidence withholds MedDRA via ${path}`, async () => {
            const res = await mcpCall(path, { name: 'sciweon_get_negative_evidence', arguments: { cid: '2244' } });
            const text = ((await res.json()) as any).result.content[0].text as string;
            expect(text).not.toContain(MEDDRA_PT);
            expect(text).not.toContain('acute_kidney_injury');
            expect(text).not.toContain('rwh_');
            const payload = JSON.parse(text);
            expect(payload.negative_signals_count).toBe(1);
            expect(payload.signals[0].id).toBeUndefined();
            expect(payload.source_visibility.withheld.some((m: any) => m.source_family === 'meddra')).toBe(true);
        });
    }
    it('non-KEGG resolve_entity still returns a mapping', async () => {
        const res = await mcpCall('/api/mcp', { name: 'sciweon_resolve_entity', arguments: { identifier: '2244' } });
        const payload = await mcpResultPayload(res);
        expect(payload.resolved).toBe(true);
        expect(payload.canonical_id).toBe('sciweon::compound::CID:2244');
        expect(payload.matched_on).toBe('pubchem_cid');
    });
});
