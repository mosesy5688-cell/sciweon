// @ts-nocheck
/**
 * PR-T1.1a R4: compound-faers-enricher one-shot-convergent re-enrich version.
 *
 * Stamps fda_signals.faers_enrich_version on a GENUINE outcome (success or
 * terminal-poison) so a re-opened v1 record CONVERGES (leaves the eligible set)
 * after a successful re-query -- not re-billing the corpus every cron, not
 * starving never-queried new compounds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../scripts/ingestion/adapters/openfda-adapter.js', () => ({
    fetchFaersSignalsByUnii: vi.fn(),
    REQUEST_DELAY_MS: 0,
}));

import { fetchFaersSignalsByUnii } from '../../scripts/ingestion/adapters/openfda-adapter.js';
import {
    isEligible, enrichOne, CURRENT_FAERS_ENRICH_VERSION,
} from '../../scripts/factory/compound-faers-enricher.js';

const mk = (id, opts = {}) => ({ id, external_ids: { unii: opts.unii ?? 'U1' }, fda_signals: opts.fda_signals });

beforeEach(() => vi.mocked(fetchFaersSignalsByUnii).mockReset());

describe('R4 faers_enrich_version stamping + convergence', () => {
    it('success stamps version=CURRENT -> v1 record converges to NOT eligible', async () => {
        // A v1-era record: array present, version 1 -> RE-eligible.
        const rec = mk('c', { fda_signals: { faers_top_adr_terms: [{ term: 'OLD', count: 1 }], faers_enrich_version: 1 } });
        expect(isEligible(rec)).toBe(true);
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue({ terms: [{ term: 'NEW', count: 5 }], truncated: false });
        await enrichOne(rec);
        expect(rec.fda_signals.faers_enrich_version).toBe(CURRENT_FAERS_ENRICH_VERSION);
        expect(isEligible(rec)).toBe(false);   // converged
    });

    it('terminal-poison path ALSO stamps version (converges, no infinite re-query)', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue(null);
        const rec = mk('c');
        await enrichOne(rec); await enrichOne(rec); await enrichOne(rec);  // 3 failures -> terminal
        expect(rec.fda_signals.faers_failed).toBe(true);
        expect(rec.fda_signals.faers_enrich_version).toBe(CURRENT_FAERS_ENRICH_VERSION);
        expect(isEligible(rec)).toBe(false);
    });

    it('a transient failure (< N) does NOT stamp version -> stays eligible', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue(null);
        const rec = mk('c');
        await enrichOne(rec);   // 1 failure
        expect(rec.fda_signals.faers_enrich_version).toBeUndefined();
        expect(isEligible(rec)).toBe(true);
    });

    it('FAERS limit lifted to 1000 (uncap) -- enrichOne keeps up to 1000 terms', async () => {
        const terms = Array.from({ length: 1000 }, (_, i) => ({ term: `T${i}`, count: 1 }));
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue({ terms, truncated: true });
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.faers_top_adr_terms.length).toBe(1000);
        expect(rec.fda_signals.faers_truncated).toBe(true);
    });
});
