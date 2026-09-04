/**
 * Composition gate - the repurposing containment classification.
 *
 * Lane 3S verified compound, xrefs, negative-evidence, target and BOTH MCP
 * aliases in tests/api/claim-containment-boundary.test.ts. It did NOT
 * individually verify the composed repurposing-evidence route. The composition
 * gate is required to CLASSIFY that path, not infer it from "only compound
 * shows N > 0".
 *
 * POSITIVE CONTROL IS MANDATORY. "No container on the wire" is vacuously true
 * if the fixture never reached the serializer. An earlier revision of this
 * file passed three assertions over a route that was in fact returning 500 --
 * the control is what caught it. Every case therefore also asserts that open
 * content from the SAME container-bearing records did arrive.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { handleRepurposingEvidence } from '../../src/worker/api/repurposing-evidence';
import { summarizeNegative } from '../../src/worker/lib/repurposing-aggregator';
import type { Env } from '../../src/worker';
import { FROZEN_CONTAINER_KEYS, CLAIM_MARKER_KEY, CLAIM_MARKER_STATE } from '../worker/claim-containment-fixture';

const DATE = '2026-05-16';
const CID = 'sciweon::compound::CID:2244';
const SENTINEL = 'SENTINEL-REPURPOSING-CLAIM-XYZZY';
const NEG_ID = 'sciweon::neg::faers::2244::SOME-PT';

function containers() {
    return {
        competing_claims: [{ path: 'iupac_name', value: SENTINEL, side: 'incoming' }],
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

// Every stored record the aggregator reads carries the six containers.
const trialLink = JSON.stringify({ compound_id: CID, nct_id: 'NCT04123456', ...containers() });
const trialRecord = JSON.stringify({
    id: 'NCT04123456', nct_id: 'NCT04123456', status: 'COMPLETED', phase: 3, ...containers(),
});
const bioRecord = JSON.stringify({
    id: 'sciweon::bioactivity::1', compound_id: CID, target_id: 'CHEMBL203',
    is_active: true, value: 10, unit: 'nM', ...containers(),
});
const paperRecord = JSON.stringify({
    id: 'sciweon::paper::PMID:1', mentioned_compounds: [{ compound_id: CID }], is_retracted: true,
    title: 'A retracted paper', pmid: '1', ...containers(),
});
// An empty-but-VALID per-bucket neg manifest: the summary path requires the
// manifest object to exist, and returns an empty summary when the compound has
// no entry. The neg examples projection is pinned by the unit case below.
const negManifest = JSON.stringify({
    version: 'v2', bucket: 1004, snapshot_date: DATE, generated_at: DATE + 'T00:00:00Z',
    total_records: 0, shard_count: 0, entries: [], shard_hashes: [],
});

function bucket() {
    const p = 'snapshots/' + DATE + '/';
    return makeMockBucket({
        'snapshots/latest.json': { bytes: utf8(JSON.stringify({ latest_snapshot_date: DATE })), etag: 'p1' },
        [p + 'trial-links.jsonl.gz']: { bytes: gz(trialLink), etag: 't0' },
        [p + 'trials.jsonl.gz']: { bytes: gz(trialRecord), etag: 't1' },
        [p + 'bioactivities.jsonl.gz']: { bytes: gz(bioRecord), etag: 'b1' },
        [p + 'papers.jsonl.gz']: { bytes: gz(paperRecord), etag: 'q1' },
        [p + 'neg-evidence/bucket-1004/manifest.json']: { bytes: utf8(negManifest), etag: 'm1' },
    });
}

async function getRepurposing() {
    const res = await handleRepurposingEvidence(
        new Request('https://x.test/api/v1/compound/2244/repurposing-evidence'),
        makeEnv(bucket()), fakeCtx(),
    );
    const raw = await res.text();
    return { res, raw, body: JSON.parse(raw) };
}

describe('composition gate: repurposing containment classification', () => {
    it('POSITIVE CONTROL: container-bearing records really reach the serializer', async () => {
        const { res, body } = await getRepurposing();
        expect(res.status).toBe(200);
        expect(body.snapshot_date).toBe(DATE);
        // Open content projected out of the SAME records that carry containers.
        expect(body.summary.positive.trials.completed_count).toBe(1);
        expect(body.summary.positive.trials.examples[0].nct_id).toBe('NCT04123456');
        expect(body.summary.positive.bioactivities.active_count).toBe(1);
        expect(body.summary.retracted.papers_count).toBe(1);
    });

    it('no claim container reaches the wire on the repurposing surface', async () => {
        const { raw } = await getRepurposing();
        for (const key of FROZEN_CONTAINER_KEYS) expect(raw).not.toContain(key);
        expect(raw).not.toContain(SENTINEL);
        expect(raw).not.toContain('CLAIM_SET_INCOMPLETE_OVERFLOW');
        expect(raw).not.toContain('999');
    });

    it('CLASSIFICATION = UPSTREAM_PROJECTION: N = 0, so NO marker is emitted', async () => {
        const { raw, body } = await getRepurposing();
        // The aggregator returns a NEW literal object and every summarizer
        // projects named fields into new objects, so containers never enter the
        // payload and the filter removes nothing. N = 0 correctly yields no
        // marker. Marker ABSENCE here is CORRECT and is NOT evidence of active
        // removal on this surface.
        expect(body[CLAIM_MARKER_KEY]).toBeUndefined();
        expect(raw).not.toContain(CLAIM_MARKER_KEY);
    });

    it('the neg examples sub-path projects to id + evidence_type only', () => {
        // The route comment flags negative.examples[].id as the MedDRA-bearing
        // field, so this sub-path is pinned directly rather than through the
        // empty-manifest fixture above.
        const out = summarizeNegative({
            signals_count: 1,
            examples: [{ id: NEG_ID, evidence_type: 'faers_signal', ...containers() }],
        } as any);
        expect(Object.keys(out.examples[0]).sort()).toEqual(['evidence_type', 'id']);
        for (const key of FROZEN_CONTAINER_KEYS) {
            expect(JSON.stringify(out)).not.toContain(key);
        }
    });
});
