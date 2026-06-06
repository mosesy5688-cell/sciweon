/**
 * Contract tests for GET /api/v1/xrefs (V0.5.8 Wave C1-2 Phase 1).
 *
 *   200  { resolved: true, canonical_id, matched_on, xrefs }
 *   400  identifier missing
 *   404  unresolvable identifier
 *   405  non-GET
 *   503  R2 binding missing
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { handleXrefs } from '../../src/worker/api/xrefs';
import type { Env } from '../../src/worker';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

// xref-index-loader uses caches.default; Node has none -> always-miss shim.
beforeAll(() => {
    if (typeof (globalThis as any).caches === 'undefined') {
        (globalThis as any).caches = { default: { async match() { return undefined; }, async put() { } } };
    }
});

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
    return {
        ASSETS: { fetch: () => new Response('static') } as Fetcher,
        SCIWEON_R2: bucket,
    };
}

function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
}

describe('handleXrefs', () => {
    const aspirinJsonl = JSON.stringify({
        id: 'sciweon::compound::CID:2244',
        pubchem_cid: 2244,
        chembl_id: 'CHEMBL25',
        inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        external_ids: {
            unii: 'R16CO5Y76E',
            drugbank_id: 'DB00945',
            chebi_id: 'CHEBI:15365',
            kegg_drug_id: 'D00109',
            rxcui: '1191',
        },
    });

    function bucket() {
        return makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-19' })),
                etag: 'p1',
            },
            'snapshots/2026-05-19/compounds-enriched.jsonl.gz': {
                bytes: gzipSync(aspirinJsonl),
                etag: 'd1',
            },
        });
    }

    async function call(query: string, env: Env) {
        const req = new Request(`https://sciweon.com/api/v1/xrefs${query}`);
        return handleXrefs(req, env, fakeCtx());
    }

    it('?id=2244 -> 200 with full xref bundle (pubchem_cid fast path)', async () => {
        const res = await call('?id=2244', makeEnv(bucket()));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.resolved).toBe(true);
        expect(body.canonical_id).toBe('sciweon::compound::CID:2244');
        expect(body.matched_on).toBe('pubchem_cid');
        expect(body.xrefs.chembl_id).toBe('CHEMBL25');
        expect(body.xrefs.external_ids.unii).toBe('R16CO5Y76E');
        expect(body.xrefs.external_ids.drugbank_id).toBe('DB00945');
    });

    it('?id=CHEMBL25 resolves via slow-path scan', async () => {
        const res = await call('?id=CHEMBL25', makeEnv(bucket()));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.canonical_id).toBe('sciweon::compound::CID:2244');
        expect(body.matched_on).toBe('chembl_id');
    });

    it('?id=UNII:R16CO5Y76E resolves via external_ids', async () => {
        const res = await call('?id=UNII:R16CO5Y76E', makeEnv(bucket()));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.matched_on).toBe('unii');
        expect(body.xrefs.pubchem_cid).toBe(2244);
    });

    it('unresolvable identifier -> 404 with resolved:false', async () => {
        const res = await call('?id=CHEMBL999999', makeEnv(bucket()));
        expect(res.status).toBe(404);
        const body = await res.json() as any;
        expect(body.resolved).toBe(false);
        expect(body.query).toBe('CHEMBL999999');
    });

    it('missing identifier param -> 400', async () => {
        const res = await call('', makeEnv(bucket()));
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.error).toContain('Identifier required');
    });

    it('non-GET method -> 405', async () => {
        const req = new Request('https://sciweon.com/api/v1/xrefs?id=2244', { method: 'POST' });
        const res = await handleXrefs(req, makeEnv(bucket()), fakeCtx());
        expect(res.status).toBe(405);
    });

    it('R2 binding missing -> 503', async () => {
        const res = await call('?id=2244', makeEnv(undefined));
        expect(res.status).toBe(503);
    });

    it('cache-control header set on 200', async () => {
        const res = await call('?id=2244', makeEnv(bucket()));
        expect(res.headers.get('cache-control')).toContain('max-age');
    });

    // PR-COMPOUND-GUARD: a non-CID id resolves via the xref-index PROJECTION
    // end-to-end (resolveEntity reads the index; loadTier1 then fetches the
    // bundle). The index is the resolution path; the full file remains for the
    // bundle hydration (loadTier1 legacy fallback when no manifest key).
    function indexedBucket() {
        return makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-19' })),
                etag: 'p1',
            },
            'snapshots/2026-05-19/xref-index.json.gz': {
                bytes: gzipSync(JSON.stringify({
                    version: '1.0', index: { drugbank_id: { DB00945: 2244 }, unii: { R16CO5Y76E: 2244 } },
                })),
                etag: 'xi1',
            },
            // loadTier1 hydrates the xref bundle from the full file (no manifest key).
            'snapshots/2026-05-19/compounds-enriched.jsonl.gz': { bytes: gzipSync(aspirinJsonl), etag: 'd1' },
        });
    }

    it('?id=DB00945 resolves via the xref-index projection end-to-end', async () => {
        const res = await call('?id=DB00945', makeEnv(indexedBucket()));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.resolved).toBe(true);
        expect(body.matched_on).toBe('drugbank_id');
        expect(body.canonical_id).toBe('sciweon::compound::CID:2244');
        expect(body.xrefs.pubchem_cid).toBe(2244);
    });
});
