/**
 * Tests for compound-rxnorm-enricher.js - cycle 22 PR-CORE-2.
 *
 * Pins the skip-if-stamped eligibility predicate + the enrichOne mutation
 * shape. RxNorm adapter is stubbed via vi.mock so no network IO.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../scripts/ingestion/adapters/rxnorm-adapter.js', () => ({
    resolveByUnii: vi.fn(),
}));

import { resolveByUnii } from '../../scripts/ingestion/adapters/rxnorm-adapter.js';
import { isEligible, enrichOne } from '../../scripts/factory/compound-rxnorm-enricher.js';

describe('isEligible', () => {
    it('UNII present + rxcui absent -> eligible', () => {
        expect(isEligible({ external_ids: { unii: 'X' } })).toBe(true);
    });

    it('UNII absent -> NOT eligible (gate fail)', () => {
        expect(isEligible({ external_ids: {} })).toBe(false);
        expect(isEligible({})).toBe(false);
        expect(isEligible(null)).toBe(false);
    });

    it('UNII present but rxcui already stamped -> NOT eligible (skip)', () => {
        expect(isEligible({ external_ids: { unii: 'X', rxcui: '111' } })).toBe(false);
    });

    it('rxcui empty string still counts as stamped (idempotent)', () => {
        // We treat any non-null rxcui as stamped to avoid retry storms.
        expect(isEligible({ external_ids: { unii: 'X', rxcui: '' } })).toBe(false);
    });
});

describe('enrichOne', () => {
    beforeEach(() => { vi.mocked(resolveByUnii).mockReset(); });

    it('stamps rxcui + rxnorm_name + rxnorm_tty + adds source on positive lookup', async () => {
        vi.mocked(resolveByUnii).mockResolvedValue({
            rxcui: '12345', rxnorm_name: 'Naproxen', tty: 'IN',
        });
        const rec = { external_ids: { unii: 'X', sources: ['unichem'] } };
        await enrichOne(rec);
        expect(rec.external_ids.rxcui).toBe('12345');
        expect(rec.external_ids.rxnorm_name).toBe('Naproxen');
        expect(rec.external_ids.rxnorm_tty).toBe('IN');
        expect(rec.external_ids.sources).toContain('rxnorm');
        expect(rec.external_ids.sources).toContain('unichem');
    });

    it('null adapter result (no match) leaves record unchanged', async () => {
        vi.mocked(resolveByUnii).mockResolvedValue(null);
        const rec = { external_ids: { unii: 'X', sources: ['unichem'] } };
        await enrichOne(rec);
        expect(rec.external_ids.rxcui).toBeUndefined();
        expect(rec.external_ids.sources).not.toContain('rxnorm');
    });

    it('initializes external_ids.sources if missing', async () => {
        vi.mocked(resolveByUnii).mockResolvedValue({ rxcui: '999' });
        const rec = { external_ids: { unii: 'X' } };
        await enrichOne(rec);
        expect(Array.isArray(rec.external_ids.sources)).toBe(true);
        expect(rec.external_ids.sources).toEqual(['rxnorm']);
    });

    it('does not duplicate "rxnorm" in sources on second call', async () => {
        vi.mocked(resolveByUnii).mockResolvedValue({ rxcui: '1' });
        const rec = { external_ids: { unii: 'X', sources: ['rxnorm'] } };
        await enrichOne(rec);
        const rxCount = rec.external_ids.sources.filter(s => s === 'rxnorm').length;
        expect(rxCount).toBe(1);
    });

    it('skips adapter call when UNII missing (defensive)', async () => {
        const rec = { external_ids: {} };
        await enrichOne(rec);
        expect(resolveByUnii).not.toHaveBeenCalled();
    });
});
