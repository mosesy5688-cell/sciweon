/**
 * Composition gate - the per-surface containment matrix, as executable evidence.
 *
 * Containment holds on every public surface, but the MECHANISM differs and the
 * two must never be written as one:
 *
 *   FILTER_REMOVAL      the route passes a stored record through, so the six
 *                       claim containers really do reach the filter, are really
 *                       removed, and a claim_metadata_visibility marker with a
 *                       non-zero removed_key_count is produced.
 *   UPSTREAM_PROJECTION the route shapes records into NEW objects before the
 *                       filter, so the filter sees N = 0 and correctly emits NO
 *                       marker. Marker absence here is CORRECT and is NOT
 *                       evidence of active removal.
 *
 * Every row is measured, not inferred. In particular, marker ABSENCE is only
 * meaningful alongside the positive control that the surface returned 200 with
 * real content, and the FILTER_REMOVAL rows are what prove the filter is armed
 * at all -- without them a wholly broken filter would still satisfy every
 * "no container on the wire" assertion in this file.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { handleCompound } from '../../src/worker/api/compound';
import { handleXrefs } from '../../src/worker/api/xrefs';
import { handleNegativeEvidence } from '../../src/worker/api/negative-evidence';
import { handleTarget } from '../../src/worker/api/target';
import { handleMcp } from '../../src/worker/api/mcp';
import type { Env } from '../../src/worker';
import { FROZEN_CONTAINER_KEYS, CLAIM_MARKER_KEY, CLAIM_MARKER_STATE } from '../worker/claim-containment-fixture';

const DATE = '2026-05-16';
const SENTINEL = 'SENTINEL-MATRIX-CLAIM-XYZZY';

function containers() {
    return {
        competing_claims: [{ path: 'iupac_name', value: SENTINEL }],
        preserved_against_null: { molecular_weight: SENTINEL },
        field_sources: { iupac_name: SENTINEL },
        claim_set_state: 'CLAIM_SET_INCOMPLETE_OVERFLOW',
        claim_overflow_fields: [SENTINEL],
        claim_overflow_counts: { competing_claims: 1 },
        claim_metadata_visibility: { state: CLAIM_MARKER_STATE, removed_key_count: 999 },
    };
}

function gz(text: string): Uint8Array {
    const { gzipSync } = require('zlib');
    return new Uint8Array(gzipSync(Buffer.from(text, 'utf-8')));
}
function utf8(s: string) { return new TextEncoder().encode(s); }

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

const compoundRecord = JSON.stringify({
    id: 'sciweon::compound::CID:2244', pubchem_cid: 2244, chembl_id: 'CHEMBL25',
    inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
    external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945' }, ...containers(),
});
const negRecord = JSON.stringify({
    id: 'sciweon::neg::trial_failure::NCT04123456', evidence_type: 'trial_failure',
    subject: { compound_id: 'sciweon::compound::CID:2244' },
    detail: {}, provenance: { primary_source: 'clinicaltrials_gov' },
    observed_date: DATE + 'T00:00:00Z', ...containers(),
});
const targetEntry = {
    uniprot_accession: 'P00533', protein_name: 'EGFR', gene_symbol: 'EGFR',
    chembl_target_id: 'CHEMBL203', organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' },
    compound_ids: [], bioactivity_ids: [], trial_ids: [], negative_evidence_ids: [], ...containers(),
};

function bucketFor(key: string, body: string) {
    return makeMockBucket({
        'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: DATE })), etag: 'p1' },
        ['snapshots/' + DATE + '/' + key]: { bytes: gz(body), etag: 'd1' },
    });
}
const targetBucket = () => makeMockBucket({
    'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: DATE })), etag: 'p1' },
    ['snapshots/' + DATE + '/target-index.json.gz']: {
        bytes: gz(JSON.stringify({ version: '0.6.0', built_at: DATE, targets: { P00533: targetEntry } })), etag: 'd1',
    },
});

/** Tier-1 misses (pointer present, no matching CID) so the Tier-2 path serves. */
function tier2Bucket() {
    const d = new Date();
    const cur = d.toISOString().slice(0, 7);
    d.setMonth(d.getMonth() - 1);
    const months = [cur, d.toISOString().slice(0, 7)];
    const rec = JSON.stringify({ pubchem_cid: 2244, iupac_name: 'aspirin', ...containers() });
    const store: Record<string, MockObject> = {
        'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: DATE })), etag: 'p1' },
        ['snapshots/' + DATE + '/compounds-enriched.jsonl.gz']: {
            bytes: gz(JSON.stringify({ pubchem_cid: 999999 })), etag: 'e1',
        },
    };
    for (const m of months) {
        store['bulk/pubchem/' + m + '/index.json'] = {
            bytes: utf8(JSON.stringify({ shards: [{ cid_range: [1, 10000], r2_key: 'bulk/pubchem/' + m + '/s0.jsonl.gz' }] })),
            etag: 'i1',
        };
        store['bulk/pubchem/' + m + '/s0.jsonl.gz'] = { bytes: gz(rec), etag: 's1' };
    }
    return makeMockBucket(store);
}

function noContainers(raw: string) {
    for (const key of FROZEN_CONTAINER_KEYS) expect(raw).not.toContain(key);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('999'); // the forged inbound marker count
}

describe('containment matrix: FILTER_REMOVAL surfaces (containers DO reach the filter)', () => {
    it('compound Tier-1: N = 6, marker present', async () => {
        const res = await handleCompound(
            new Request('https://x.test/api/v1/compound/2244'),
            makeEnv(bucketFor('compounds-enriched.jsonl.gz', compoundRecord)), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        const body = JSON.parse(raw);
        expect(body.compound._tier).toBe('T1'); // positive control: real record served
        noContainers(raw);
        expect(body[CLAIM_MARKER_KEY]).toEqual({ state: CLAIM_MARKER_STATE, removed_key_count: 6 });
    });

    it('compound Tier-2: N = 6, marker present', async () => {
        // The Tier-2 stub is ALSO spread into the response, so it is a second
        // FILTER_REMOVAL point. Lane 3S covered Tier-1 only; this row is the
        // composition gate closing the matrix.
        const res = await handleCompound(
            new Request('https://x.test/api/v1/compound/2244'), makeEnv(tier2Bucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        const body = JSON.parse(raw);
        expect(body.compound._tier).toBe('T2'); // positive control: Tier-2 path taken
        noContainers(raw);
        expect(body[CLAIM_MARKER_KEY]).toEqual({ state: CLAIM_MARKER_STATE, removed_key_count: 6 });
    });
});

describe('containment matrix: UPSTREAM_PROJECTION surfaces (N = 0, no marker)', () => {
    it('xrefs: N = 0, NO marker', async () => {
        const res = await handleXrefs(new Request('https://x.test/api/v1/xrefs?id=2244'),
            makeEnv(bucketFor('compounds-enriched.jsonl.gz', compoundRecord)), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(JSON.parse(raw).xrefs.external_ids.drugbank_id).toBe('DB00945'); // control
        noContainers(raw);
        expect(JSON.parse(raw)[CLAIM_MARKER_KEY]).toBeUndefined();
    });

    it('negative-evidence: N = 0, NO marker', async () => {
        const res = await handleNegativeEvidence(
            new Request('https://x.test/api/v1/compound/2244/negative-evidence'),
            makeEnv(bucketFor('neg-evidence.jsonl.gz', negRecord)), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).toContain('trial_failure'); // control: the record was served
        noContainers(raw);
        expect(JSON.parse(raw)[CLAIM_MARKER_KEY]).toBeUndefined();
    });

    it('target: N = 0, NO marker', async () => {
        const res = await handleTarget(new Request('https://x.test/api/v1/target/P00533'),
            makeEnv(targetBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(JSON.parse(raw).target.gene_symbol).toBe('EGFR'); // control
        noContainers(raw);
        expect(JSON.parse(raw)[CLAIM_MARKER_KEY]).toBeUndefined();
    });

    for (const path of ['/api/mcp', '/api/v1/mcp']) {
        it('MCP alias ' + path + ': N = 0, NO marker', async () => {
            const res = await handleMcp(new Request('https://x.test' + path, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'tools/call',
                    params: { name: 'sciweon_get_negative_evidence', arguments: { cid: '2244' } },
                }),
            }), makeEnv(bucketFor('neg-evidence.jsonl.gz', negRecord)), fakeCtx());
            const envelope = await res.text();
            noContainers(envelope); // raw scan of the WHOLE response, envelope included
            const text = JSON.parse(envelope).result.content[0].text as string;
            expect(text).toContain('trial_failure'); // control
            noContainers(text);
            expect(JSON.parse(text)[CLAIM_MARKER_KEY]).toBeUndefined();
        });
    }
});
