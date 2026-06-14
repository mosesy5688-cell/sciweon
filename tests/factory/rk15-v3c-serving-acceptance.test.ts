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
    bindCandidate, candidatePrefix, sha256Hex, PROD_LATEST_KEY,
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

describe('RK-15 V3-C — candidate binding (latest == INPUT candidate; NO derive-and-accept)', () => {
    // A complete immutable_snapshot_v2 latest.json for the NEW candidate.
    const NEW_ID = '2026-06-14/27489690948-1';
    const OLD_ID = '2026-06-13/27467183738-1';
    const v2Latest = (id: string, manifestHash: string | null = 'mh-abc') => JSON.stringify({
        layout_version: 'immutable_snapshot_v2',
        snapshot_id: id,
        object_prefix: `snapshots/${id}/`,
        compounds_manifest_key: `snapshots/${id}/compounds/bucket-0000/manifest.json`,
        ...(manifestHash ? { manifest_hash: manifestHash } : {}),
    });
    const legacyV1 = JSON.stringify({ latest_snapshot_date: '2026-06-14' });

    // A mock R2 client that returns `latestText` for the latest.json GET. Wrapped
    // in the read-only guard so we also prove put_count stays 0 throughout.
    const clientFor = (latestText: string) => instrumentReadOnlyClient({
        async send(cmd: any) {
            if (cmd?.input?.Key === PROD_LATEST_KEY) return { Body: latestText, ETag: '"e"' };
            throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        },
    });

    it('NEW input + latest points at the NEW candidate (matching payload hash) -> PASS', async () => {
        const latest = v2Latest(NEW_ID);
        const inst = clientFor(latest);
        const res = await bindCandidate(inst, 'bkt', { candidate_snapshot_id: NEW_ID, candidate_payload_hash: sha256Hex(Buffer.from(latest, 'utf-8')) });
        expect(res.check.pass).toBe(true);
        expect(res.check.latest_snapshot_id).toBe(NEW_ID);
        expect(res.candidatePrefix).toBe(`snapshots/${NEW_ID}/`);
        expect(putCount(inst)).toBe(0);
    });

    it('OLD input + latest points at the NEW candidate -> HARD FAIL (snapshot_id mismatch; no auto-switch to latest id)', async () => {
        const latest = v2Latest(NEW_ID);
        const res = await bindCandidate(clientFor(latest), 'bkt', { candidate_snapshot_id: OLD_ID, candidate_payload_hash: sha256Hex(Buffer.from(latest, 'utf-8')) });
        expect(res.check.pass).toBe(false);
        expect(res.check.snapshot_id_match).toBe(false);
        expect(res.check.candidate_snapshot_id).toBe(OLD_ID); // binds the INPUT, not latest
        expect(res.check.reason).toMatch(/no derive-and-accept/i);
    });

    it('snapshot_id matches but payload-hash MISMATCHES -> HARD FAIL', async () => {
        const latest = v2Latest(NEW_ID);
        const res = await bindCandidate(clientFor(latest), 'bkt', { candidate_snapshot_id: NEW_ID, candidate_payload_hash: 'deadbeef-wrong-hash' });
        expect(res.check.pass).toBe(false);
        expect(res.check.snapshot_id_match).toBe(true);
        expect(res.check.payload_hash_match).toBe(false);
    });

    it('manifest_hash input mismatches latest.manifest_hash -> HARD FAIL', async () => {
        const latest = v2Latest(NEW_ID, 'mh-abc');
        const res = await bindCandidate(clientFor(latest), 'bkt', { candidate_snapshot_id: NEW_ID, candidate_payload_hash: sha256Hex(Buffer.from(latest, 'utf-8')), manifest_hash: 'mh-WRONG' });
        expect(res.check.pass).toBe(false);
        expect(res.check.manifest_hash_match).toBe(false);
    });

    it('production latest is legacy_v1 (not immutable_v2) -> HARD FAIL', async () => {
        const res = await bindCandidate(clientFor(legacyV1), 'bkt', { candidate_snapshot_id: NEW_ID, candidate_payload_hash: sha256Hex(Buffer.from(legacyV1, 'utf-8')) });
        expect(res.check.pass).toBe(false);
        expect(res.check.is_immutable_v2).toBe(false);
        expect(res.check.latest_layout_version).toBe('legacy_v1');
    });

    it('missing required input (candidate_payload_hash) -> HARD FAIL (never reads R2)', async () => {
        let read = false;
        const inst = instrumentReadOnlyClient({ async send() { read = true; return { Body: v2Latest(NEW_ID) }; } });
        const res = await bindCandidate(inst, 'bkt', { candidate_snapshot_id: NEW_ID });
        expect(res.check.pass).toBe(false);
        expect(res.check.reason).toMatch(/missing required/i);
        expect(read).toBe(false);
    });

    it('candidatePrefix + ALL candidate R2 reads are keyed on the INPUT id (not a hardcoded old id)', () => {
        expect(candidatePrefix(NEW_ID)).toBe(`snapshots/${NEW_ID}/`);
        expect(candidatePrefix(NEW_ID)).not.toContain(OLD_ID);
        // A shard key built from the input prefix carries the INPUT id.
        const shardKey = `${candidatePrefix(NEW_ID)}compounds/bucket-0000/shard-000.bin`;
        expect(shardKey).toContain(NEW_ID);
        expect(shardKey).not.toContain('27467183738');
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
