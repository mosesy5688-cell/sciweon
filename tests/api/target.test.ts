/**
 * Contract tests for GET /api/v1/target/:uniprot{,/drugs,/trials,/negative-evidence}
 *
 *   200  full target response with shape-shifted body per suffix
 *   400  malformed uniprot accession
 *   404  target not in index OR index file missing
 *   405  non-GET
 *   503  R2 binding missing
 */

import { describe, it, expect } from 'vitest';
import { handleTarget } from '../../src/worker/api/target';
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
    return { ASSETS: { fetch: () => new Response('static') } as Fetcher, SCIWEON_R2: bucket };
}

function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
}

function utf8(s: string) { return new TextEncoder().encode(s); }

const SNAPSHOT_DATE = '2026-05-21';

function makeStore(targets: Record<string, any>): Record<string, MockObject> {
    const pointer = JSON.stringify({ latest_snapshot_date: SNAPSHOT_DATE });
    const idx = JSON.stringify({ version: '0.6.0', built_at: '2026-05-21T12:00:00Z', targets });
    return {
        'snapshots/latest.json': { bytes: utf8(pointer), etag: 'etag-ptr' },
        [`snapshots/${SNAPSHOT_DATE}/target-index.json`]: { bytes: utf8(idx), etag: 'etag-idx' },
    };
}

const P00533_ENTRY = {
    uniprot_accession: 'P00533',
    protein_name: 'EGFR',
    gene_symbol: 'EGFR',
    chembl_target_id: 'CHEMBL203',
    organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' },
    compound_ids: ['sciweon::compound::CID:1', 'sciweon::compound::CID:2'],
    bioactivity_ids: ['sciweon::bioactivity::1', 'sciweon::bioactivity::2'],
    trial_ids: ['sciweon::trial::NCT:00000001'],
    negative_evidence_ids: ['sciweon::neg::bioassay::1'],
};

describe('handleTarget', () => {
    it('GET /api/v1/target/:uniprot returns summary with counts only', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/P00533');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.snapshot_date).toBe(SNAPSHOT_DATE);
        expect(body.target.uniprot_accession).toBe('P00533');
        expect(body.target.counts).toEqual({ compounds: 2, bioactivities: 2, trials: 1, negative_evidence: 1 });
        // Summary path should NOT include the full id arrays.
        expect(body.target.compound_ids).toBeUndefined();
        expect(body.target.trial_ids).toBeUndefined();
    });

    it('GET /drugs returns compound_ids + bioactivity_ids', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/P00533/drugs');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.target.compound_ids).toEqual(['sciweon::compound::CID:1', 'sciweon::compound::CID:2']);
        expect(body.target.bioactivity_ids).toEqual(['sciweon::bioactivity::1', 'sciweon::bioactivity::2']);
    });

    it('GET /trials returns trial_ids', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/P00533/trials');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.target.trial_ids).toEqual(['sciweon::trial::NCT:00000001']);
    });

    it('GET /negative-evidence returns negative_evidence_ids', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/P00533/negative-evidence');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.target.negative_evidence_ids).toEqual(['sciweon::neg::bioassay::1']);
    });

    it('accepts lowercased input and uppercases canonical', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/p00533');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.target.uniprot_accession).toBe('P00533');
    });

    it('returns 400 on malformed uniprot accession', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/not-a-uniprot');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(400);
    });

    it('returns 404 when target is not in the index', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/Q12345');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(404);
    });

    it('returns 404 when target-index.json file is missing', async () => {
        // Pointer present, index absent — simulates the first cron after deploy.
        const store: Record<string, MockObject> = {
            'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: SNAPSHOT_DATE })), etag: 'etag-ptr' },
        };
        const bucket = makeMockBucket(store);
        const req = new Request('https://x.test/api/v1/target/P00533');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(404);
    });

    it('returns 503 when R2 binding missing', async () => {
        const req = new Request('https://x.test/api/v1/target/P00533');
        const res = await handleTarget(req, makeEnv(undefined), fakeCtx());
        expect(res.status).toBe(503);
    });

    it('returns 405 on non-GET', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/P00533', { method: 'POST' });
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(405);
    });

    it('sets cache-control + schema-minor headers on 200', async () => {
        const bucket = makeMockBucket(makeStore({ P00533: P00533_ENTRY }));
        const req = new Request('https://x.test/api/v1/target/P00533');
        const res = await handleTarget(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toMatch(/max-age=300/);
        expect(res.headers.get('x-sciweon-schema-minor')).toBe('0.6.0');
    });
});
