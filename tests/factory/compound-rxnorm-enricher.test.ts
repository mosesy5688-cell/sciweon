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
import { isEligible, enrichOne, bulkEnrichOne } from '../../scripts/factory/compound-rxnorm-enricher.js';

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

describe('PR-RXN-1d bulk fast-path: bulkEnrichOne', () => {
    function makeBulkMaps(entries) {
        // entries: Array<[unii, {rxcui, preferred_str?, tty?, sab?}]>
        return { uniiToRxcui: new Map(entries) };
    }

    it('1. mutation shape byte-identical to enrichOne (rxcui+rxnorm_name+rxnorm_tty+sources)', async () => {
        // Reference: enrichOne with resolveByUnii mock returning equivalent payload
        vi.mocked(resolveByUnii).mockResolvedValue({ rxcui: '12345', rxnorm_name: 'Naproxen', tty: 'IN' });
        const restRec = { external_ids: { unii: '8MJB9HSC8Q', sources: ['unichem'] } };
        await enrichOne(restRec);

        // Under test: bulkEnrichOne with maps holding the same identity
        const maps = makeBulkMaps([['8MJB9HSC8Q', { rxcui: '12345', preferred_str: 'Naproxen', tty: 'IN', sab: 'RXNORM' }]]);
        const bulkRec = { external_ids: { unii: '8MJB9HSC8Q', sources: ['unichem'] } };
        bulkEnrichOne(bulkRec, maps);

        // Field-level equality on the four stamped fields
        expect(bulkRec.external_ids.rxcui).toBe(restRec.external_ids.rxcui);
        expect(bulkRec.external_ids.rxnorm_name).toBe(restRec.external_ids.rxnorm_name);
        expect(bulkRec.external_ids.rxnorm_tty).toBe(restRec.external_ids.rxnorm_tty);
        expect(bulkRec.external_ids.sources.sort()).toEqual(restRec.external_ids.sources.sort());
    });

    it('2. preserves existing non-empty sources[] (no duplicate rxnorm)', () => {
        const maps = makeBulkMaps([['U1', { rxcui: '111', preferred_str: 'X', tty: 'IN' }]]);
        const rec = { external_ids: { unii: 'U1', sources: ['unichem', 'rxnorm'] } };
        bulkEnrichOne(rec, maps);
        const rxCount = rec.external_ids.sources.filter(s => s === 'rxnorm').length;
        expect(rxCount).toBe(1);
        expect(rec.external_ids.sources).toContain('unichem');
    });

    it('3. no map hit leaves record unchanged + returns false', () => {
        const maps = makeBulkMaps([]);
        const rec = { external_ids: { unii: 'NOMATCH', sources: ['unichem'] } };
        const drift = bulkEnrichOne(rec, maps);
        expect(drift).toBe(false);
        expect(rec.external_ids.rxcui).toBeUndefined();
        expect(rec.external_ids.sources).toEqual(['unichem']);
    });

    it('4. lower-case + whitespace-padded UNII still hits canonical key + flags drift', () => {
        const maps = makeBulkMaps([['8MJB9HSC8Q', { rxcui: '999', preferred_str: 'Drug', tty: 'IN' }]]);
        const rec = { external_ids: { unii: '  8mjb9hsc8q  ' } };
        const drift = bulkEnrichOne(rec, maps);
        expect(drift).toBe(true);
        expect(rec.external_ids.rxcui).toBe('999');
        expect(rec.external_ids.rxnorm_name).toBe('Drug');
    });

    it('5. composite: bulk-hit + bulk-miss + already-stamped -> only bulk-miss remains eligible for REST', () => {
        const maps = makeBulkMaps([
            ['UHIT', { rxcui: '101', preferred_str: 'Hit', tty: 'IN' }],
        ]);
        const records = [
            { id: 'CID:1', external_ids: { unii: 'UHIT' } },                  // bulk-hit
            { id: 'CID:2', external_ids: { unii: 'UMISS' } },                  // bulk-miss
            { id: 'CID:3', external_ids: { unii: 'UPRE', rxcui: '999' } },     // already-stamped
        ];
        let bulk_hits = 0;
        for (const r of records) {
            bulkEnrichOne(r, maps);
            if (r.external_ids?.rxcui && r.external_ids.rxcui !== '999') bulk_hits++;
        }
        expect(bulk_hits).toBe(1);
        const remaining = records.filter(isEligible);
        expect(remaining.length).toBe(1);
        expect(remaining[0].id).toBe('CID:2');
        // already-stamped record's rxcui preserved (idempotent short-circuit)
        expect(records[2].external_ids.rxcui).toBe('999');
    });

    it('6. defensive: missing external_ids / missing unii / non-string unii -> false, no mutation', () => {
        const maps = makeBulkMaps([['U1', { rxcui: '111' }]]);
        expect(bulkEnrichOne(null, maps)).toBe(false);
        expect(bulkEnrichOne({}, maps)).toBe(false);
        expect(bulkEnrichOne({ external_ids: {} }, maps)).toBe(false);
        const rec = { external_ids: { unii: 12345 } };
        expect(bulkEnrichOne(rec as any, maps)).toBe(false);
        expect(rec.external_ids.rxcui).toBeUndefined();
    });
});
