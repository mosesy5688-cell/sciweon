// @ts-nocheck
/**
 * Tests for compound-fda-srs-enricher.js -- Phase 1.8 PR-FDA-SRS-2.
 *
 * Focus: isEligible truth table + makeEnrichOne closure behavior (Rail 6
 * disagreement telemetry + Rail 10a shared-reference field assignment +
 * Rail 10b Max-10 conflict warning truncation). Full drain integration
 * covered by drain-adapter-backlog.test.ts already.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../scripts/ingestion/adapters/fda-srs-adapter.js', () => ({
    lookupByInchiKey: vi.fn(),
    normalizeInChIKey: vi.fn(k => (typeof k === 'string' ? k.toUpperCase().trim() : null)),
    loadLookupFromR2: vi.fn(),
}));

import { lookupByInchiKey } from '../../scripts/ingestion/adapters/fda-srs-adapter.js';
import { isEligible, makeEnrichOne } from '../../scripts/factory/compound-fda-srs-enricher.js';

function mkCompound(id, opts = {}) {
    return {
        id, inchi_key: opts.inchi_key ?? 'RDHQFKQIGNGIED-UHFFFAOYSA-N',
        external_ids: opts.external_ids ?? {},
        ...opts,
    };
}

beforeEach(() => { vi.mocked(lookupByInchiKey).mockReset(); });

describe('isEligible -- Rail 5 + Rail 9 truth table', () => {
    it('accepts record with inchi_key and no fda_srs source', () => {
        expect(isEligible(mkCompound('cid:1'))).toBe(true);
    });

    it('rejects record missing inchi_key (Rail 9 empty path)', () => {
        expect(isEligible({ id: 'cid:1', inchi_key: null, external_ids: {} })).toBe(false);
        expect(isEligible({ id: 'cid:1', external_ids: {} })).toBe(false);
    });

    it('rejects record already fda_srs-stamped (idempotent re-run)', () => {
        const r = mkCompound('cid:1', { external_ids: { sources: ['fda_srs'] } });
        expect(isEligible(r)).toBe(false);
    });

    it('accepts UniChem-stamped record (Rail 6 cross-validation eligible)', () => {
        const r = mkCompound('cid:1', { external_ids: { sources: ['unichem'], unii: 'X' } });
        expect(isEligible(r)).toBe(true);
    });

    it('rejects null / undefined records defensively', () => {
        expect(isEligible(null)).toBe(false);
        expect(isEligible(undefined)).toBe(false);
    });
});

describe('makeEnrichOne -- Rail 10a shared-reference + Rail 6 disagreement', () => {
    it('fills unii + preferred_name + cas_rn + fda_srs source on un-stamped record', async () => {
        vi.mocked(lookupByInchiKey).mockReturnValue({ unii: 'XYZ123', preferred_name: 'TESTOL', cas_rn: '111-22-3' });
        const conflictState = { count: 0, warnedSamples: 0 };
        const enrich = makeEnrichOne(new Map(), conflictState);
        const rec = mkCompound('cid:1');
        await enrich(rec);
        expect(rec.external_ids.unii).toBe('XYZ123');
        expect(rec.external_ids.preferred_name).toBe('TESTOL');
        expect(rec.external_ids.cas_rn).toBe('111-22-3');
        expect(rec.external_ids.sources).toEqual(['fda_srs']);
    });

    it('preserves prior unii (first-wins) when SRS xref agrees', async () => {
        vi.mocked(lookupByInchiKey).mockReturnValue({ unii: 'XYZ123', preferred_name: null, cas_rn: null });
        const conflictState = { count: 0, warnedSamples: 0 };
        const enrich = makeEnrichOne(new Map(), conflictState);
        const rec = mkCompound('cid:1', { external_ids: { sources: ['unichem'], unii: 'XYZ123' } });
        await enrich(rec);
        expect(rec.external_ids.unii).toBe('XYZ123');
        expect(rec.external_ids.sources).toEqual(['unichem', 'fda_srs']);
        expect(conflictState.count).toBe(0);
    });

    it('Rail 6: emits [FDA-SRS-CONFLICT] warn on disagreement; preserves prior (first-wins)', async () => {
        vi.mocked(lookupByInchiKey).mockReturnValue({ unii: 'NEWNEWNEWNEW', preferred_name: null, cas_rn: null });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const conflictState = { count: 0, warnedSamples: 0 };
        const enrich = makeEnrichOne(new Map(), conflictState);
        const rec = mkCompound('cid:1', { external_ids: { sources: ['unichem'], unii: 'OLDOLDOLDOLD' } });
        await enrich(rec);
        expect(rec.external_ids.unii).toBe('OLDOLDOLDOLD');  // first-wins preserved
        expect(rec.external_ids.sources).toEqual(['unichem', 'fda_srs']);
        expect(conflictState.count).toBe(1);
        expect(conflictState.warnedSamples).toBe(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/\[FDA-SRS-CONFLICT\].*InChIKey.*prior unii=OLDOLDOLDOLD.*differs from FDA SRS unii=NEWNEWNEWNEW/);
        warnSpy.mockRestore();
    });

    it('Rail 10b: caps conflict warning emissions at 10 per run; atomic-counts rest', async () => {
        vi.mocked(lookupByInchiKey).mockReturnValue({ unii: 'NEW' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const conflictState = { count: 0, warnedSamples: 0 };
        const enrich = makeEnrichOne(new Map(), conflictState);
        for (let i = 0; i < 25; i++) {
            const rec = mkCompound(`cid:${i}`, { external_ids: { sources: ['unichem'], unii: 'OLD' } });
            await enrich(rec);
        }
        expect(conflictState.count).toBe(25);
        expect(conflictState.warnedSamples).toBe(10);  // capped
        expect(warnSpy).toHaveBeenCalledTimes(10);
        warnSpy.mockRestore();
    });

    it('no-op when adapter returns null (FDA SRS has no entry for InChIKey)', async () => {
        vi.mocked(lookupByInchiKey).mockReturnValue(null);
        const conflictState = { count: 0, warnedSamples: 0 };
        const enrich = makeEnrichOne(new Map(), conflictState);
        const rec = mkCompound('cid:1');
        await enrich(rec);
        expect(rec.external_ids.unii).toBeUndefined();
        expect(rec.external_ids.sources).toBeUndefined();
    });

    it('Rail 10a: enrichOne mutates in-place; does NOT deep-clone xref or external_ids', async () => {
        const xref = { unii: 'X', preferred_name: 'P', cas_rn: 'C' };
        vi.mocked(lookupByInchiKey).mockReturnValue(xref);
        const conflictState = { count: 0, warnedSamples: 0 };
        const enrich = makeEnrichOne(new Map(), conflictState);
        const originalExternalIds = { sources: [] };
        const rec = { id: 'cid:1', inchi_key: 'RDHQFKQIGNGIED-UHFFFAOYSA-N', external_ids: originalExternalIds };
        await enrich(rec);
        // record.external_ids must be SAME reference (mutated in place), not a new object
        expect(rec.external_ids).toBe(originalExternalIds);
    });
});
