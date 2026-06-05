// @ts-nocheck
/**
 * PR-FAERS-KEY (Step-5b): compound-faers-enricher sentinel + poison contract.
 *
 * Locks the status-class sentinel contract (part 3), the saturation flag
 * (part 5), and the poison-UNII attempt-counter + terminal marker (part 4).
 * The adapter's fetchFaersSignalsByUnii is mocked: it returns
 *   - { terms, truncated }  on success / genuine-empty
 *   - null                  on a FETCH FAILURE (429/5xx/timeout/network)
 *
 * isEligible truth table:
 *   - UNII absent              -> false (gate)
 *   - faers_top_adr_terms []   -> false (genuine-empty OR terminal-failed = done)
 *   - faers_top_adr_terms unset-> true  (fetch failure left it un-stamped)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../scripts/ingestion/adapters/openfda-adapter.js', () => ({
    fetchFaersSignalsByUnii: vi.fn(),
    REQUEST_DELAY_MS: 0,
}));

import { fetchFaersSignalsByUnii } from '../../scripts/ingestion/adapters/openfda-adapter.js';
import { isEligible, enrichOne } from '../../scripts/factory/compound-faers-enricher.js';

function mk(id, opts = {}) {
    return { id, external_ids: { unii: opts.unii ?? 'UNII123' }, fda_signals: opts.fda_signals };
}

beforeEach(() => { vi.mocked(fetchFaersSignalsByUnii).mockReset(); });

describe('isEligible truth table', () => {
    it('UNII absent -> not eligible', () => {
        expect(isEligible({ id: 'c', external_ids: {} })).toBe(false);
    });
    it('faers_top_adr_terms unset -> eligible (never queried / fetch-failed)', () => {
        expect(isEligible(mk('c'))).toBe(true);
    });
    it('faers_top_adr_terms is an array ([] or filled) -> not eligible (done)', () => {
        expect(isEligible(mk('c', { fda_signals: { faers_top_adr_terms: [] } }))).toBe(false);
        expect(isEligible(mk('c', { fda_signals: { faers_top_adr_terms: [{ term: 'X', count: 1 }] } }))).toBe(false);
    });
});

describe('enrichOne -- genuine-empty (part 3)', () => {
    it('empty results -> stamps [] -> isEligible false (completes), no error', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue({ terms: [], truncated: false });
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.faers_top_adr_terms).toEqual([]);
        expect(rec.fda_signals.faers_total_top_count).toBe(0);
        expect(rec.fda_signals.faers_queried_at).toBeTypeOf('string');
        expect(rec.fda_signals.faers_failed).toBeUndefined();
        expect(isEligible(rec)).toBe(false);
    });

    it('signals -> stamps terms + count + source membership', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue({
            terms: [{ term: 'NAUSEA', count: 10 }, { term: 'RASH', count: 3 }], truncated: false,
        });
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.faers_total_top_count).toBe(13);
        expect(rec.fda_signals.sources).toContain('openfda_faers');
        expect(isEligible(rec)).toBe(false);
    });
});

describe('enrichOne -- fetch failure sentinel (part 3) + poison terminal (part 4)', () => {
    it('null (fetch failure) -> does NOT stamp faers_top_adr_terms -> stays eligible', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue(null);
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.faers_top_adr_terms).toBeUndefined();
        expect(rec.fda_signals.faers_attempts).toBe(1);
        expect(isEligible(rec)).toBe(true);   // requeried next cron
    });

    it('poison UNII: terminal faers_failed after N=3 failures -> leaves eligible set', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue(null);
        const rec = mk('c');
        await enrichOne(rec);   // attempt 1
        expect(isEligible(rec)).toBe(true);
        await enrichOne(rec);   // attempt 2
        expect(isEligible(rec)).toBe(true);
        await enrichOne(rec);   // attempt 3 -> terminal
        expect(rec.fda_signals.faers_attempts).toBe(3);
        expect(rec.fda_signals.faers_failed).toBe(true);
        expect(rec.fda_signals.faers_top_adr_terms).toEqual([]);  // stamped -> done
        expect(isEligible(rec)).toBe(false);  // poison record LEAVES eligible set
    });

    it('terminal-failed is DISTINGUISHABLE from genuine-empty (faers_failed flag)', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue(null);
        const poison = mk('p');
        for (let i = 0; i < 3; i++) await enrichOne(poison);
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue({ terms: [], truncated: false });
        const empty = mk('e');
        await enrichOne(empty);
        // Both have [] but only the poison record carries faers_failed.
        expect(poison.fda_signals.faers_failed).toBe(true);
        expect(empty.fda_signals.faers_failed).toBeUndefined();
    });

    it('enrichOne NEVER throws even if the adapter throws (suspenders)', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockRejectedValue(new Error('boom'));
        const rec = mk('c');
        await expect(enrichOne(rec)).resolves.toBe(rec);
        expect(rec.fda_signals.faers_attempts).toBe(1);  // folded into failure path
        expect(isEligible(rec)).toBe(true);
    });
});

describe('enrichOne -- saturation flag (part 5)', () => {
    it('truncated:true -> sets faers_truncated:true (top-N slice, KEEP limit=30)', async () => {
        const terms = Array.from({ length: 30 }, (_, i) => ({ term: `T${i}`, count: 1 }));
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue({ terms, truncated: true });
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.faers_truncated).toBe(true);
        expect(rec.fda_signals.faers_top_adr_terms.length).toBe(30);
    });

    it('not saturated -> faers_truncated NOT set', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue({
            terms: [{ term: 'X', count: 1 }], truncated: false,
        });
        const rec = mk('c');
        await enrichOne(rec);
        expect(rec.fda_signals.faers_truncated).toBeUndefined();
    });
});
