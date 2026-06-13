// @ts-nocheck
/**
 * RK-15 V3-C — STRICT READ-ONLY serving acceptance. These lock the CONTROL
 * LOGIC of the harness against mocks (the real R2 source/candidate reads + live
 * worker probes are confirmed only at the live V3-C dispatch). Covers: the
 * read-only WRITE-GUARD (any PutObject -> hard fail), the exact three-layer
 * parity rules, the surface registry (incl. NOT-APPLICABLE with evidence), the
 * repeated-request stability evaluator, source-synonym CID resolution, and the
 * legacy compensating-evidence recording (never "prewarm PASS").
 */

import { describe, it, expect } from 'vitest';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
    instrumentReadOnlyClient, putCount, classifyParity, evalStability,
    scanSourceJsonl, faersFromRecord, getObject,
} from '../../scripts/verify/rk15-v3c-lib.js';
import { buildSurfaceRegistry, probeSurface } from '../../scripts/verify/rk15-v3c-surfaces.js';

describe('RK-15 V3-C — READ-ONLY write-GUARD (put_count must be 0)', () => {
    it('HARD-FAILS the instant a PutObject is constructed (read-only contract)', async () => {
        const inst = instrumentReadOnlyClient({ async send() { return {}; } });
        await expect(inst.send(new PutObjectCommand({ Bucket: 'b', Key: 'snapshots/latest.json', Body: 'x' }))).rejects.toThrow(/READ-ONLY GUARD/i);
        expect(putCount(inst)).toBe(1); // it SAW a write (and refused it) — surfaced for the audit.
    });
    it('HARD-FAILS any other write/delete command too', async () => {
        const inst = instrumentReadOnlyClient({ async send() { return {}; } });
        await expect(inst.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }))).rejects.toThrow(/READ-ONLY GUARD/i);
    });
    it('ALLOWS GetObject (read-only) and never increments put_count', async () => {
        let got = false;
        const inst = instrumentReadOnlyClient({ async send() { got = true; return { Body: 'hi' }; } });
        await inst.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
        expect(got).toBe(true);
        expect(putCount(inst)).toBe(0);
    });
});

describe('RK-15 V3-C — three-layer parity rules (§3, exact)', () => {
    it('source=0,cand=0,live=0 -> faithful (PASS, NOT a regression)', () => {
        const v = classifyParity({ source_faers_term_count: 0, candidate_faers_term_count: 0, live_faers_term_count: 0 });
        expect(v.parity_result).toBe('faithful_zero'); expect(v.pass).toBe(true);
    });
    it('source>0,cand=0 -> candidate build/publish defect (FAIL)', () => {
        const v = classifyParity({ source_faers_term_count: 12, candidate_faers_term_count: 0, live_faers_term_count: 0 });
        expect(v.parity_result).toBe('candidate_build_defect'); expect(v.pass).toBe(false);
    });
    it('source>0,cand>0,live=0 -> reader/serving defect (FAIL)', () => {
        const v = classifyParity({ source_faers_term_count: 30, candidate_faers_term_count: 30, live_faers_term_count: 0 });
        expect(v.parity_result).toBe('serving_defect'); expect(v.pass).toBe(false);
    });
    it('source=0,cand>0,live>0 -> transform_explain (PASS w/ note, not data loss)', () => {
        const v = classifyParity({ source_faers_term_count: 0, candidate_faers_term_count: 5, live_faers_term_count: 5 });
        expect(v.parity_result).toBe('transform_explain'); expect(v.pass).toBe(true); expect(v.note).toMatch(/transform/i);
    });
    it('source>0,cand>0,live>0 consistent -> PASS', () => {
        const v = classifyParity({ source_faers_term_count: 42, candidate_faers_term_count: 42, live_faers_term_count: 42 });
        expect(v.parity_result).toBe('consistent'); expect(v.pass).toBe(true);
    });
});

describe('RK-15 V3-C — source FAERS + synonym CID resolution (from source, NOT hardcoded)', () => {
    const jsonl = Buffer.from([
        JSON.stringify({ pubchem_cid: 2244, name: 'aspirin', synonyms: ['acetylsalicylic acid'], fda_signals: { faers_top_adr_terms: ['a', 'b', 'c'], faers_total_top_count: 99 } }),
        JSON.stringify({ pubchem_cid: 54678486, name: 'Sertraline', synonyms: ['Zoloft'], fda_signals: { faers_top_adr_terms: [], faers_total_top_count: 0 } }),
        JSON.stringify({ pubchem_cid: 54678486 + 1, name: 'WARFARIN', synonyms: ['Coumadin'] }),
        JSON.stringify({ pubchem_cid: 135398744, name: 'sildenafil', synonyms: ['Viagra'], fda_signals: { faers_top_adr_terms: ['x'], faers_total_top_count: 1 } }),
    ].join('\n'), 'utf-8');

    it('extracts faers term-count from a source record', () => {
        const f = faersFromRecord(JSON.parse(jsonl.toString().split('\n')[0]));
        expect(f.faers_term_count).toBe(3); expect(f.faers_total_count).toBe(99);
    });
    it('resolves warfarin/sildenafil CIDs from the source synonyms[]/name (case-insensitive)', () => {
        const { byCid, synonymHits } = scanSourceJsonl(jsonl, [2244], ['warfarin', 'sildenafil']);
        expect(synonymHits.get('warfarin')).toBe(54678487);
        expect(synonymHits.get('sildenafil')).toBe(135398744);
        expect(byCid.get(2244).name).toBe('aspirin');
    });
});

describe('RK-15 V3-C — surface registry (code-sourced; N/A carries evidence)', () => {
    const reg = buildSurfaceRegistry({ tier1Cid: 2244, namedCids: [2244] });
    it('covers the real surfaces with file:line evidence', () => {
        for (const name of ['compound', 'negative-evidence', 'xrefs', 'repurposing-evidence', 'papers', 'trials', 'bioactivities', 'target', 'mcp', 'health']) {
            const s = reg.find(r => r.surface === name);
            expect(s, name).toBeDefined();
            expect(s.applicable).toBe(true);
            expect(s.evidence).toMatch(/\.ts:\d+|worker\.ts/);
        }
    });
    it('records search + entity as NOT APPLICABLE — NO PUBLIC ROUTE with router evidence', () => {
        for (const name of ['search', 'entity']) {
            const s = reg.find(r => r.surface === name);
            expect(s.applicable).toBe(false);
            expect(s.reason).toMatch(/NOT APPLICABLE/i);
            expect(s.evidence).toMatch(/worker\.ts/);
        }
    });
});

describe('RK-15 V3-C — repeated-request stability (§6)', () => {
    it('stable when status/tier/faers are identical across repeats', () => {
        const samples = Array.from({ length: 5 }, () => ({ status: 200, tier: 'T1', faers_term_count: 42 }));
        expect(evalStability(samples, ['status', 'tier', 'faers_term_count']).stable).toBe(true);
    });
    it('FAILS (stable=false) when the tier FLAPS across repeats', () => {
        const samples = [{ status: 200, tier: 'T1', faers_term_count: 42 }, { status: 200, tier: 'T2', faers_term_count: 0 }];
        const r = evalStability(samples, ['status', 'tier', 'faers_term_count']);
        expect(r.stable).toBe(false); expect(r.field).toBe('tier');
    });
    it('FAILS when a nonzero faers count drops to zero (no nonzero->zero)', () => {
        const samples = [{ status: 200, tier: 'T1', faers_term_count: 42 }, { status: 200, tier: 'T1', faers_term_count: 0 }];
        expect(evalStability(samples, ['faers_term_count']).stable).toBe(false);
    });
});

describe('RK-15 V3-C — probeSurface (live HTTP, mocked fetch)', () => {
    it('normalizes a Tier-1 compound response into a stable sample', async () => {
        const fetchMock = async () => ({ status: 200, async text() { return JSON.stringify({ id: 'x', compound: { _tier: 'T1', fda_signals: { faers_top_adr_terms: ['a', 'b'], faers_total_top_count: 7 } } }); } });
        const reg = buildSurfaceRegistry({ tier1Cid: 2244, namedCids: [2244] });
        const s = await probeSurface('https://sciweon.com', reg.find(r => r.surface === 'compound'), fetchMock);
        expect(s.status).toBe(200); expect(s.tier).toBe('T1'); expect(s.faers_term_count).toBe(2);
    });
    it('skips a NOT-APPLICABLE surface without a network call', async () => {
        const reg = buildSurfaceRegistry({ tier1Cid: 2244, namedCids: [2244] });
        const s = await probeSurface('https://sciweon.com', reg.find(r => r.surface === 'search'), async () => { throw new Error('should not fetch'); });
        expect(s.applicable).toBe(false);
    });
});
