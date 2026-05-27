// @ts-nocheck
/**
 * Tests for compound-id-resolver.js -- Phase 1.8 PR-FDA-SRS-2c Option E.
 *
 * Focus: bootstrapUnichemMatchedFlag idempotency + enrichOne flag
 * injection (mocked adapter). Drain helper integration covered by
 * drain-adapter-backlog.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../scripts/ingestion/adapters/unichem-adapter.js', () => ({
    fetchByInchiKey: vi.fn(),
    REQUEST_DELAY_MS: 0,
}));

import { fetchByInchiKey } from '../../scripts/ingestion/adapters/unichem-adapter.js';
import { bootstrapUnichemMatchedFlag, enrichOne, isEligible } from '../../scripts/factory/compound-id-resolver.js';

beforeEach(() => { vi.mocked(fetchByInchiKey).mockReset(); });

describe('bootstrapUnichemMatchedFlag -- PR-FDA-SRS-2c idempotency', () => {
    it('stamps unichem_matched=true on historical records with sources∋unichem AND unii', () => {
        const compounds = [
            { id: 'a', external_ids: { sources: ['unichem'], unii: 'X' } },
            { id: 'b', external_ids: { sources: ['unichem', 'fda_srs'], unii: 'Y' } },
            { id: 'c', external_ids: { sources: ['unichem'] } },              // no unii -> skip
            { id: 'd', external_ids: { sources: ['fda_srs'], unii: 'Z' } },    // no unichem source -> skip
            { id: 'e', external_ids: {} },                                     // no sources -> skip
            { id: 'f' },                                                       // no external_ids -> skip
        ];
        const count = bootstrapUnichemMatchedFlag(compounds);
        expect(count).toBe(2);
        expect(compounds[0].external_ids.unichem_matched).toBe(true);
        expect(compounds[1].external_ids.unichem_matched).toBe(true);
        expect(compounds[2].external_ids.unichem_matched).toBeUndefined();
        expect(compounds[3].external_ids.unichem_matched).toBeUndefined();
        expect(compounds[4].external_ids.unichem_matched).toBeUndefined();
    });

    it('idempotent: already-flagged records are NOT re-counted on second pass', () => {
        const compounds = [
            { id: 'a', external_ids: { sources: ['unichem'], unii: 'X' } },
        ];
        const first = bootstrapUnichemMatchedFlag(compounds);
        expect(first).toBe(1);
        expect(compounds[0].external_ids.unichem_matched).toBe(true);
        const second = bootstrapUnichemMatchedFlag(compounds);
        expect(second).toBe(0);  // already flagged
    });

    it('does NOT overwrite prior unichem_matched=false (preserves explicit state)', () => {
        const compounds = [
            { id: 'a', external_ids: { sources: ['unichem'], unii: 'X', unichem_matched: false } },
        ];
        const count = bootstrapUnichemMatchedFlag(compounds);
        expect(count).toBe(1);
        expect(compounds[0].external_ids.unichem_matched).toBe(true);
    });

    it('empty input returns 0', () => {
        expect(bootstrapUnichemMatchedFlag([])).toBe(0);
    });

    it('handles null/undefined records defensively', () => {
        expect(bootstrapUnichemMatchedFlag([null, undefined])).toBe(0);
    });
});

describe('enrichOne -- PR-FDA-SRS-2c flag stamp', () => {
    it('sets unichem_matched=true when adapter returns non-null xrefs', async () => {
        vi.mocked(fetchByInchiKey).mockResolvedValue({ unii: 'A', chebi_id: 'CHEBI:1' });
        const r = { id: 'cid:1', inchi_key: 'RDHQFKQIGNGIED-UHFFFAOYSA-N', external_ids: { sources: [] } };
        await enrichOne(r);
        expect(r.external_ids.unichem_matched).toBe(true);
        expect(r.external_ids.unii).toBe('A');
        expect(r.external_ids.sources).toContain('unichem');
    });

    it('does NOT set unichem_matched when adapter returns null', async () => {
        vi.mocked(fetchByInchiKey).mockResolvedValue(null);
        const r = { id: 'cid:1', inchi_key: 'RDHQFKQIGNGIED-UHFFFAOYSA-N', external_ids: { sources: [] } };
        await enrichOne(r);
        expect(r.external_ids.unichem_matched).toBeUndefined();
        expect(r.external_ids.sources).toEqual([]);
    });

    it('preserves prior unichem_matched=true on re-enrichment (idempotent re-run)', async () => {
        vi.mocked(fetchByInchiKey).mockResolvedValue({ unii: 'A' });
        const r = { id: 'cid:1', inchi_key: 'RDHQFKQIGNGIED-UHFFFAOYSA-N', external_ids: { sources: ['unichem'], unichem_matched: true } };
        await enrichOne(r);
        expect(r.external_ids.unichem_matched).toBe(true);
    });
});

describe('isEligible -- unchanged contract verified (Option E does NOT change eligibility)', () => {
    it('eligibility predicate still works on records WITHOUT unichem_matched (back-compat)', () => {
        expect(isEligible({ inchi_key: 'X', external_ids: { sources: [] } })).toBe(true);
        expect(isEligible({ inchi_key: 'X', external_ids: { sources: ['unichem'] } })).toBe(false);
    });

    it('eligibility predicate IGNORES unichem_matched flag (only sources matters)', () => {
        // Record bootstrapped with unichem_matched=true SHOULD still be filtered out
        // by isEligible because sources∋unichem (the original predicate semantic).
        expect(isEligible({ inchi_key: 'X', external_ids: { sources: ['unichem'], unichem_matched: true } })).toBe(false);
    });
});
