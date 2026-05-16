/**
 * Contract tests for /api/v1/compound/:id/negative-evidence
 *
 * Anchored in SCIWEON_DATA_ARCHITECTURE §3.0:
 *   - well-formed canonical ID    → 200
 *   - well-formed short ID (numeric only / CID:n) → 200, same payload shape
 *   - malformed ID                → 400
 *   - no R2 binding               → 503
 *   - missing snapshot pointer    → 404
 *
 * Mocks the R2Bucket interface so tests run without network or wrangler.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseCompoundId } from '../../src/worker/lib/id-parse';
import { handleNegativeEvidence } from '../../src/worker/api/negative-evidence';
import type { Env } from '../../src/worker';

function gzipSync(text: string): Uint8Array {
    // Node 22+ provides zlib; tests run in Node, so use it directly.
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
                async arrayBuffer() { return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength); },
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

describe('parseCompoundId', () => {
    it('accepts canonical form', () => {
        const r = parseCompoundId('sciweon::compound::CID:2244');
        expect(r).toEqual({ canonical: 'sciweon::compound::CID:2244', cid: 2244 });
    });

    it('accepts short CID: prefix', () => {
        const r = parseCompoundId('CID:2244');
        expect(r).toEqual({ canonical: 'sciweon::compound::CID:2244', cid: 2244 });
    });

    it('accepts numeric only', () => {
        const r = parseCompoundId('2244');
        expect(r).toEqual({ canonical: 'sciweon::compound::CID:2244', cid: 2244 });
    });

    it('rejects empty', () => {
        const r = parseCompoundId('');
        expect(r).toHaveProperty('error');
    });

    it('rejects non-numeric junk', () => {
        const r = parseCompoundId('not-a-cid');
        expect(r).toHaveProperty('error');
    });

    it('rejects out-of-range', () => {
        const r = parseCompoundId('99999999999999');
        expect(r).toHaveProperty('error');
    });
});

describe('handleNegativeEvidence', () => {
    let bucket: R2Bucket;

    beforeEach(() => {
        const jsonl = [
            JSON.stringify({
                id: 'sciweon::neg::trial_failure::NCT04123456',
                evidence_type: 'trial_failure',
                subject: { compound_id: 'sciweon::compound::CID:2244', trial_id: 'sciweon::trial::NCT:04123456' },
                failure: { reason_category: 'SAFETY', extraction_method: 'v0.1_keyword_classifier', extraction_confidence: 80 },
                severity: 'major',
                observed_date: '2026-05-15T03:25:00Z',
                confidence: { overall: 85, method: 'negative_evidence_v1' },
                provenance: { primary_source: 'clinicaltrials_gov', source_id: 'NCT04123456', extraction_timestamp: '2026-05-15T03:25:00Z' },
            }),
            JSON.stringify({
                id: 'sciweon::neg::black_box_warning::OPENFDA-AAA',
                evidence_type: 'black_box_warning',
                subject: { compound_id: 'sciweon::compound::CID:2244' },
                failure: { extraction_method: 'fda_label_section' },
                severity: 'critical',
                observed_date: '2026-05-15T03:25:00Z',
                confidence: { overall: 95, method: 'negative_evidence_v1' },
                provenance: { primary_source: 'openfda_drug_label', source_id: 'OPENFDA-AAA', extraction_timestamp: '2026-05-15T03:25:00Z' },
            }),
            JSON.stringify({
                id: 'sciweon::neg::trial_failure::NCT04999999',
                evidence_type: 'trial_failure',
                subject: { compound_id: 'sciweon::compound::CID:9999' },
                failure: { reason_category: 'ENROLLMENT', extraction_method: 'v0.1_keyword_classifier' },
                severity: 'minor',
                observed_date: '2026-05-15T03:25:00Z',
                confidence: { overall: 75, method: 'negative_evidence_v1' },
                provenance: { primary_source: 'clinicaltrials_gov', source_id: 'NCT04999999', extraction_timestamp: '2026-05-15T03:25:00Z' },
            }),
        ].join('\n');
        bucket = makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-16' })),
                etag: 'pointer-etag-1',
            },
            'snapshots/2026-05-16/neg-evidence.jsonl.gz': {
                bytes: gzipSync(jsonl),
                etag: 'neg-etag-1',
            },
        });
    });

    async function call(idPath: string, env: Env) {
        const req = new Request(`https://sciweon.com/api/v1/compound/${idPath}/negative-evidence`);
        return handleNegativeEvidence(req, env, fakeCtx());
    }

    it('returns 200 for compound with two signals (canonical ID)', async () => {
        const res = await call('sciweon%3A%3Acompound%3A%3ACID%3A2244', makeEnv(bucket));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.compound.id).toBe('sciweon::compound::CID:2244');
        expect(body.negative_signals_count).toBe(2);
        expect(body.signals_by_severity.critical).toBe(1);
        expect(body.signals_by_severity.major).toBe(1);
        expect(body.verdict.highest_severity).toBe('critical');
        expect(body.signals.length).toBe(2);
        expect(body.snapshot_date).toBe('2026-05-16');
    });

    it('returns 200 with same payload for short numeric ID', async () => {
        const res = await call('2244', makeEnv(bucket));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.compound.id).toBe('sciweon::compound::CID:2244');
        expect(body.negative_signals_count).toBe(2);
    });

    it('returns 200 with zero signals when compound has none', async () => {
        const res = await call('1111', makeEnv(bucket));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.negative_signals_count).toBe(0);
        expect(body.verdict.highest_severity).toBe('none');
    });

    it('returns 400 for malformed ID', async () => {
        const res = await call('not-a-valid-id', makeEnv(bucket));
        expect(res.status).toBe(400);
        const body = await res.json() as any;
        expect(body.error).toContain('Invalid entity ID format');
    });

    it('returns 503 when R2 binding is missing', async () => {
        const res = await call('2244', makeEnv(undefined));
        expect(res.status).toBe(503);
    });

    it('returns 405 on non-GET methods', async () => {
        const req = new Request('https://sciweon.com/api/v1/compound/2244/negative-evidence', { method: 'POST' });
        const res = await handleNegativeEvidence(req, makeEnv(bucket), fakeCtx());
        expect(res.status).toBe(405);
    });

    it('cache-control header is set', async () => {
        const res = await call('2244', makeEnv(bucket));
        expect(res.headers.get('cache-control')).toContain('max-age');
    });
});
