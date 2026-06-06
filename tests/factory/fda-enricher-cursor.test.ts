// @ts-nocheck
/**
 * PR-T1.1a R4: fda-enricher cursor + version-eligibility + sentinel.
 *
 * The fda-enricher must DRAIN INCREMENTALLY (version/skip-if-stamped) rather
 * than full-walk the corpus every cron (the founder's budget/staging fix --
 * the faers re-enrich + this label/recall re-fetch share the openFDA quota +
 * TokenBucket). isEligible converges: an enriched-at-current-version record
 * LEAVES the eligible set; a never-/v1-stamped record stays eligible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../scripts/ingestion/adapters/openfda-adapter.js', () => ({
    fetchLabelsByUnii: vi.fn(),
    fetchRecallsByUnii: vi.fn(),
    aggregateSignals: vi.fn(),
    REQUEST_DELAY_MS: 0,
}));

import {
    fetchLabelsByUnii, fetchRecallsByUnii, aggregateSignals,
} from '../../scripts/ingestion/adapters/openfda-adapter.js';
import {
    isEligible, enrichOne, mergeFdaSignals, CURRENT_FDA_ENRICH_VERSION,
} from '../../scripts/factory/fda-enricher.js';

const mk = (id, opts = {}) => ({
    id, external_ids: { unii: opts.unii ?? 'U1' }, fda_signals: opts.fda_signals,
});

beforeEach(() => {
    vi.mocked(fetchLabelsByUnii).mockReset();
    vi.mocked(fetchRecallsByUnii).mockReset();
    vi.mocked(aggregateSignals).mockReset();
});

describe('R4 isEligible truth table (version-convergent)', () => {
    it('UNII absent -> not eligible', () => {
        expect(isEligible({ id: 'c', external_ids: {} })).toBe(false);
    });
    it('never enriched (no fda_enrich_version) -> eligible', () => {
        expect(isEligible(mk('c'))).toBe(true);
    });
    it('enriched at < current version (v1) -> RE-eligible (uncap backfill)', () => {
        expect(isEligible(mk('c', { fda_signals: { fda_enrich_version: 1, label_count: 1 } }))).toBe(true);
    });
    it('enriched at current version -> NOT eligible (converged)', () => {
        expect(isEligible(mk('c', { fda_signals: { fda_enrich_version: CURRENT_FDA_ENRICH_VERSION } }))).toBe(false);
    });
});

describe('R4 enrichOne sentinel + convergence', () => {
    it('success -> merges signals + stamps version -> converges (leaves eligible)', async () => {
        vi.mocked(fetchLabelsByUnii).mockResolvedValue({ results: [{ boxed_warning: ['w'] }], truncated: false });
        vi.mocked(fetchRecallsByUnii).mockResolvedValue({ results: [], truncated: false });
        vi.mocked(aggregateSignals).mockReturnValue({ label_count: 1, has_boxed_warning: true });
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.label_count).toBe(1);
        expect(rec.fda_signals.fda_enrich_version).toBe(CURRENT_FDA_ENRICH_VERSION);
        expect(isEligible(rec)).toBe(false);
    });

    it('FETCH FAILURE (labels null) -> does NOT stamp version -> stays eligible', async () => {
        vi.mocked(fetchLabelsByUnii).mockResolvedValue(null);
        vi.mocked(fetchRecallsByUnii).mockResolvedValue({ results: [], truncated: false });
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals?.fda_enrich_version).toBeUndefined();
        expect(isEligible(rec)).toBe(true);
    });

    it('FETCH FAILURE (recalls null) -> stays eligible', async () => {
        vi.mocked(fetchLabelsByUnii).mockResolvedValue({ results: [], truncated: false });
        vi.mocked(fetchRecallsByUnii).mockResolvedValue(null);
        const rec = mk('c');
        await enrichOne(rec);
        expect(isEligible(rec)).toBe(true);
    });

    it('genuine-empty (aggregateSignals null) STILL stamps version -> converges (no infinite re-query)', async () => {
        vi.mocked(fetchLabelsByUnii).mockResolvedValue({ results: [], truncated: false });
        vi.mocked(fetchRecallsByUnii).mockResolvedValue({ results: [], truncated: false });
        vi.mocked(aggregateSignals).mockReturnValue(null);
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.fda_enrich_version).toBe(CURRENT_FDA_ENRICH_VERSION);
        expect(isEligible(rec)).toBe(false);
    });

    it('enrichOne NEVER throws even if the adapter throws', async () => {
        vi.mocked(fetchLabelsByUnii).mockRejectedValue(new Error('boom'));
        const rec = mk('c');
        await expect(enrichOne(rec)).resolves.toBe(rec);
        expect(isEligible(rec)).toBe(true);   // stayed eligible (failure path)
    });

    it('passes the R3 truncated flags through to aggregateSignals', async () => {
        vi.mocked(fetchLabelsByUnii).mockResolvedValue({ results: [{ boxed_warning: ['w'] }], truncated: true });
        vi.mocked(fetchRecallsByUnii).mockResolvedValue({ results: [], truncated: true });
        vi.mocked(aggregateSignals).mockReturnValue({ label_count: 1 });
        await enrichOne(mk('c'));
        expect(vi.mocked(aggregateSignals)).toHaveBeenCalledWith(
            expect.any(Array), expect.any(Array),
            { labelTruncated: true, recallTruncated: true },
        );
    });
});

describe('R4 incremental drain (does NOT full-walk: converged records excluded)', () => {
    it('a mixed corpus filters to ONLY the eligible (not the whole set)', () => {
        const corpus = [
            mk('a'),                                                   // never -> eligible
            mk('b', { fda_signals: { fda_enrich_version: 1 } }),      // v1 -> eligible
            mk('c', { fda_signals: { fda_enrich_version: CURRENT_FDA_ENRICH_VERSION } }), // converged
            { id: 'd', external_ids: {} },                            // no UNII
        ];
        const eligible = corpus.filter(isEligible);
        expect(eligible.map(r => r.id)).toEqual(['a', 'b']);   // NOT a full-walk
    });
});

describe('mergeFdaSignals preserved (FILL-not-replace still exported)', () => {
    it('keeps pre-existing faers_* while openFDA fields win', () => {
        const merged = mergeFdaSignals({ faers_total_top_count: 9 }, { label_count: 2 });
        expect(merged.faers_total_top_count).toBe(9);
        expect(merged.label_count).toBe(2);
    });
});
