/**
 * Lane 3S -- containment at the SERVING BOUNDARY, end to end.
 *
 * The claim containers are injected into the STORED record, so each case
 * exercises the real loader -> route -> serializer path rather than the filter
 * in isolation.
 *
 * MCP cases use the repository's dual idiom deliberately: a raw-string
 * `not.toContain` on the response text AND a parsed structural assertion. The
 * payload is a JSON STRING inside `content[0].text`; asserting only on the
 * parsed object, or only on the envelope, is the single most likely way this
 * lane ships a green test over a leaking surface.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleCompound } from '../../src/worker/api/compound';
import { handleXrefs } from '../../src/worker/api/xrefs';
import { handleNegativeEvidence } from '../../src/worker/api/negative-evidence';
import { handleTarget } from '../../src/worker/api/target';
import { handleMcp } from '../../src/worker/api/mcp';
import type { Env } from '../../src/worker';
import { FROZEN_CONTAINER_KEYS, CLAIM_MARKER_KEY, CLAIM_MARKER_STATE } from '../worker/claim-containment-fixture';

const DATE = '2026-05-16';
const FORGED = { state: CLAIM_MARKER_STATE, removed_key_count: 999 };
const SENTINEL = 'SENTINEL-BOUNDARY-CLAIM-XYZZY';

/** The six containers plus a forged marker, as they would sit on a record. */
function containers() {
    return {
        competing_claims: [{ path: 'iupac_name', value: SENTINEL, side: 'incoming', source: { source: null, status: 'unknown' } }],
        preserved_against_null: { molecular_weight: SENTINEL },
        field_sources: { iupac_name: SENTINEL },
        claim_set_state: 'CLAIM_SET_INCOMPLETE_OVERFLOW',
        claim_overflow_fields: [SENTINEL],
        claim_overflow_counts: { competing_claims: 1 },
        claim_metadata_visibility: FORGED,
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

const compoundRecord = JSON.stringify({
    id: 'sciweon::compound::CID:2244', pubchem_cid: 2244, chembl_id: 'CHEMBL25',
    inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
    external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945', rxcui: '1191' },
    ...containers(),
});
const negRecord = JSON.stringify({
    id: 'sciweon::neg::trial_failure::NCT04123456', evidence_type: 'trial_failure',
    subject: { compound_id: 'sciweon::compound::CID:2244' },
    detail: {}, provenance: { primary_source: 'clinicaltrials_gov' },
    observed_date: '2026-05-16T00:00:00Z', ...containers(),
});
const targetEntry = {
    uniprot_accession: 'P00533', protein_name: 'EGFR', gene_symbol: 'EGFR',
    chembl_target_id: 'CHEMBL203', organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' },
    compound_ids: [], bioactivity_ids: [], trial_ids: [], negative_evidence_ids: [],
    ...containers(),
};

function bucketFor(key: string, body: string) {
    return makeMockBucket({
        'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: DATE })), etag: 'p1' },
        ['snapshots/' + DATE + '/' + key]: { bytes: gz(body), etag: 'd1' },
    });
}
const xrefBucket = () => bucketFor('compounds-enriched.jsonl.gz', compoundRecord);
const negBucket = () => bucketFor('neg-evidence.jsonl.gz', negRecord);
const targetBucket = () => makeMockBucket({
    'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: DATE })), etag: 'p1' },
    ['snapshots/' + DATE + '/target-index.json.gz']: {
        bytes: gz(JSON.stringify({ version: '0.6.0', built_at: DATE, targets: { P00533: targetEntry } })), etag: 'd1',
    },
});

/** Every containment assertion a covered surface must satisfy. */
function assertContained(raw: string, body: any) {
    for (const key of FROZEN_CONTAINER_KEYS) expect(raw).not.toContain(key);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('999');
    expect(raw).not.toContain('CLAIM_SET_INCOMPLETE_OVERFLOW');
    // Test 13 (5c): the business root must be a PLAIN OBJECT, never wrapped.
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
    expect(Array.isArray(body)).toBe(false);
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
}

describe('REST surfaces -- containers never reach the wire', () => {
    it('compound 200: record passed through WHOLE -> containers removed AND marked', async () => {
        // The compound route spreads the Tier-1 record shallowly, so the
        // containers really do reach the filter. This is the surface the lane
        // exists for, and the only one that yields a non-zero marker.
        const res = await handleCompound(new Request('https://x.test/api/v1/compound/2244'), makeEnv(xrefBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        const body = JSON.parse(raw);
        assertContained(raw, body);
        expect(body[CLAIM_MARKER_KEY]).toEqual({ state: CLAIM_MARKER_STATE, removed_key_count: 6 });
        // Marker is a DIRECT key of the response root, exactly once, never per record.
        expect(raw.split(CLAIM_MARKER_KEY).length - 1).toBe(1);
        expect(Object.keys(body)).toContain(CLAIM_MARKER_KEY);
        expect(body.compound[CLAIM_MARKER_KEY]).toBeUndefined();
    });
    it('xrefs 200: containers absent; the route SHAPES the record, so N = 0', async () => {
        // Recorded honestly: here the containers never enter the payload,
        // because the route builds a new object rather than passing the record
        // through. The filter removes nothing and correctly emits NO marker
        // (5c: "N = 0 yields no marker"). Lane 3S is defence in depth on this
        // surface -- it would catch the shaper widening.
        const res = await handleXrefs(new Request('https://x.test/api/v1/xrefs?id=2244'), makeEnv(xrefBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        const body = JSON.parse(raw);
        assertContained(raw, body);
        expect(body[CLAIM_MARKER_KEY]).toBeUndefined();
        expect(body.xrefs.external_ids.drugbank_id).toBe('DB00945'); // open content preserved
    });
    it('negative-evidence 200: containers absent from the serialized output', async () => {
        const res = await handleNegativeEvidence(
            new Request('https://x.test/api/v1/compound/2244/negative-evidence'), makeEnv(negBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        assertContained(raw, JSON.parse(raw));
    });
    it('target 200: containers absent from the serialized output', async () => {
        const res = await handleTarget(new Request('https://x.test/api/v1/target/P00533'), makeEnv(targetBucket()), fakeCtx());
        expect(res.status).toBe(200);
        const raw = await res.text();
        assertContained(raw, JSON.parse(raw));
    });
});

describe('MCP boundary -- BOTH aliases, dual idiom', () => {
    function mcpCall(path: string, params: object) {
        return handleMcp(new Request('https://x.test' + path, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
        }), makeEnv(negBucket()), fakeCtx());
    }
    for (const path of ['/api/mcp', '/api/v1/mcp']) {
        it('get_negative_evidence contains no container via ' + path, async () => {
            const res = await mcpCall(path, { name: 'sciweon_get_negative_evidence', arguments: { cid: '2244' } });
            const envelope = await res.text();
            // RAW-STRING scan of the whole response, envelope included.
            for (const key of FROZEN_CONTAINER_KEYS) expect(envelope).not.toContain(key);
            expect(envelope).not.toContain(SENTINEL);
            // PARSED structural assertion on the business object inside text.
            const text = JSON.parse(envelope).result.content[0].text as string;
            const payload = JSON.parse(text);
            assertContained(text, payload);
            // The marker belongs to the business root, NOT the JSON-RPC envelope.
            expect(Object.keys(JSON.parse(envelope))).not.toContain(CLAIM_MARKER_KEY);
        });
    }
});

describe('section 8 -- the x-sciweon-rights-filter sync to rc3a-v2', () => {
    // Seven literals in five files. `xrefs.ts:51` is a 403 RESPONSE-INIT
    // header on the rights-policy path, not a filtered success body.
    const expected: Record<string, number> = {
        'src/worker/api/compound.ts': 2,
        'src/worker/api/negative-evidence.ts': 1,
        'src/worker/api/repurposing-evidence.ts': 1,
        'src/worker/api/target.ts': 1,
        'src/worker/api/xrefs.ts': 2,
    };
    it('all seven literals read rc3a-v2 and none reads rc3a-v1', () => {
        let total = 0;
        for (const [file, n] of Object.entries(expected)) {
            const src = readFileSync(file, 'utf8');
            const v2 = (src.match(/'x-sciweon-rights-filter': 'rc3a-v2'/g) || []).length;
            expect(v2).toBe(n);
            expect(src).not.toContain('rc3a-v1'); // KNOWN NEGATIVE, differs from n
            total += v2;
        }
        expect(total).toBe(7);
    });
    it('the header is observable as rc3a-v2 on a success AND on the 403 path', async () => {
        const ok = await handleXrefs(new Request('https://x.test/api/v1/xrefs?id=2244'), makeEnv(xrefBucket()), fakeCtx());
        expect(ok.status).toBe(200);
        expect(ok.headers.get('x-sciweon-rights-filter')).toBe('rc3a-v2');
        const denied = await handleXrefs(new Request('https://x.test/api/v1/xrefs?id=D00109'), makeEnv(xrefBucket()), fakeCtx());
        expect(denied.status).toBe(403);
        expect(denied.headers.get('x-sciweon-rights-filter')).toBe('rc3a-v2');
    });
    it('the MCP surface carries no rights-filter header at all (open PM item)', async () => {
        const res = await handleMcp(new Request('https://x.test/api/mcp', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        }), makeEnv(negBucket()), fakeCtx());
        // Recorded, not fixed: the surface whose behaviour changes most carries
        // no version signal. Fixing it is not in this lane's scope.
        expect(res.headers.get('x-sciweon-rights-filter')).toBeNull();
    });
});
