/**
 * Tests for aggregated-backfill-enrich.js - cycle 22 PR-CORE-3.
 *
 * R2 cursor IO + the 3 underlying adapter HTTP calls are mocked. The
 * focus: cursor write-on-failure (D8), per-source error isolation,
 * stamp counting using isEligible round-trip predicate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../scripts/factory/lib/enrichment-cursor.js', async () => {
    const actual: typeof import('../../scripts/factory/lib/enrichment-cursor.js') =
        await vi.importActual('../../scripts/factory/lib/enrichment-cursor.js');
    return {
        ...actual,
        readCursor: vi.fn().mockResolvedValue(null),
        writeCursor: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('../../scripts/ingestion/adapters/unichem-adapter.js', () => ({
    fetchByInchiKey: vi.fn(),
    REQUEST_DELAY_MS: 0,
}));

vi.mock('../../scripts/ingestion/adapters/rxnorm-adapter.js', () => ({
    resolveByUnii: vi.fn(),
}));

vi.mock('../../scripts/ingestion/adapters/openfda-adapter.js', () => ({
    fetchFaersSignalsByUnii: vi.fn(),
    REQUEST_DELAY_MS: 0,
}));

import { readCursor, writeCursor } from '../../scripts/factory/lib/enrichment-cursor.js';
import { fetchByInchiKey } from '../../scripts/ingestion/adapters/unichem-adapter.js';
import { resolveByUnii } from '../../scripts/ingestion/adapters/rxnorm-adapter.js';
import { fetchFaersSignalsByUnii } from '../../scripts/ingestion/adapters/openfda-adapter.js';
import { backfillOneSource } from '../../scripts/factory/aggregated-backfill-enrich.js';

beforeEach(() => {
    vi.mocked(readCursor).mockReset().mockResolvedValue(null);
    vi.mocked(writeCursor).mockReset().mockResolvedValue(undefined);
    vi.mocked(fetchByInchiKey).mockReset();
    vi.mocked(resolveByUnii).mockReset();
    vi.mocked(fetchFaersSignalsByUnii).mockReset();
});

function mkCompound(id: string, opts: Record<string, unknown> = {}) {
    return {
        id,
        inchi_key: `KEY_${id}`,
        external_ids: opts.external_ids ?? {},
        ...opts,
    } as Record<string, unknown>;
}

describe('backfillOneSource (unichem)', () => {
    it('skips records already UniChem-stamped', async () => {
        const compounds = [
            mkCompound('sciweon::compound::CID:1', { external_ids: { sources: ['unichem'], unii: 'X' } }),
            mkCompound('sciweon::compound::CID:2', { external_ids: { sources: ['unichem'], unii: 'Y' } }),
        ];
        const r = await backfillOneSource('unichem', compounds);
        expect(r.processed).toBe(0);
        expect(r.stamped).toBe(0);
        expect(r.error).toBe(null);
        expect(fetchByInchiKey).not.toHaveBeenCalled();
    });

    it('drains all eligible records across multiple chunks (PR-CORE-DRAIN-1d)', async () => {
        // Post-drain-migration semantics: helper drains until corpus wraps,
        // not chunk-and-exit. With 3 eligible records and chunk_size=2,
        // drain processes chunk 1 (records 10+20) then last partial chunk
        // (record 30) via effectiveChunkSize cap that prevents wrap re-emit.
        vi.mocked(readCursor).mockResolvedValue({ source: 'unichem', cursor_id: null, chunk_size: 2 } as never);
        vi.mocked(fetchByInchiKey).mockResolvedValue({ unii: 'XYZ' });
        const compounds = [
            mkCompound('sciweon::compound::CID:10'),
            mkCompound('sciweon::compound::CID:20'),
            mkCompound('sciweon::compound::CID:30'),
        ];
        const r = await backfillOneSource('unichem', compounds);
        expect(r.processed).toBe(3);
        expect(r.stamped).toBe(3);
        expect(fetchByInchiKey).toHaveBeenCalledTimes(3);
        expect(writeCursor).toHaveBeenCalled();
    });

    it('reports partial progress on mid-drain adapter failure (D8 contract)', async () => {
        // Post-drain-migration: drain helper bubbles up on enrichOne throw.
        // wrappedEnrichOne increments processedAttempts post-await so r.processed
        // accurately counts records the adapter finished BEFORE the failure.
        // The drain helper does NOT persist cursor when it throws (no
        // finalCursorResult on the error path); cursor advance happens only
        // on successful completion. This is a deliberate V5 contract change
        // from the original D8 "write cursor even on partial failure" -- in
        // V5 the cursor stays at prior value so next cycle resumes the
        // same slice idempotently via isEligible filter.
        vi.mocked(readCursor).mockResolvedValue({ source: 'unichem', cursor_id: null, chunk_size: 5 } as never);
        vi.mocked(fetchByInchiKey)
            .mockResolvedValueOnce({ unii: 'A' })
            .mockResolvedValueOnce({ unii: 'B' })
            .mockRejectedValueOnce(new Error('rate limit'));
        const compounds = [
            mkCompound('sciweon::compound::CID:1'),
            mkCompound('sciweon::compound::CID:2'),
            mkCompound('sciweon::compound::CID:3'),
            mkCompound('sciweon::compound::CID:4'),
        ];
        const r = await backfillOneSource('unichem', compounds);
        expect(r.error).toMatch(/rate limit/);
        expect(r.processed).toBe(2);  // records 1 + 2 succeeded; record 3 threw
        expect(r.stamped).toBe(2);
    });

    it('throws on unknown source id', async () => {
        await expect(backfillOneSource('not_a_real_source', [])).rejects.toThrow(/Unknown source/);
    });
});

describe('backfillOneSource (rxnorm)', () => {
    it('only processes UNII-bearing records missing rxcui', async () => {
        vi.mocked(resolveByUnii).mockResolvedValue({ rxcui: '12345' });
        const compounds = [
            mkCompound('sciweon::compound::CID:1', { external_ids: { sources: ['unichem'] } }),                 // no UNII -> gate fail
            mkCompound('sciweon::compound::CID:2', { external_ids: { unii: 'X', rxcui: '999' } }),              // already stamped
            mkCompound('sciweon::compound::CID:3', { external_ids: { unii: 'Y' } }),                            // eligible
        ];
        const r = await backfillOneSource('rxnorm', compounds);
        expect(r.processed).toBe(1);
        expect(r.stamped).toBe(1);
        expect(resolveByUnii).toHaveBeenCalledTimes(1);
        expect(resolveByUnii).toHaveBeenCalledWith('Y');
        expect(compounds[2].external_ids).toMatchObject({ rxcui: '12345' });
    });
});

describe('backfillOneSource (rxnorm) — PR-RXN-1g Fix A bulk pre-pass', () => {
    function maps(uniiPairs: [string, string][]) {
        return {
            uniiToRxcui: new Map(uniiPairs.map(([u, r]) => [u, { rxcui: r, preferred_str: `d${r}`, tty: 'IN' }])),
            ndcToRxcuis: new Map(),
        };
    }

    it('stamps in-bulk-map UNIIs in-memory and routes only the long tail to REST', async () => {
        vi.mocked(resolveByUnii).mockResolvedValue({ rxcui: 'REST999' });
        const compounds = [
            mkCompound('sciweon::compound::CID:1', { external_ids: { unii: 'AAAAAAAAAA' } }),  // in bulk map
            mkCompound('sciweon::compound::CID:2', { external_ids: { unii: 'ZZZZZZZZZZ' } }),  // long tail -> REST
        ];
        const r = await backfillOneSource('rxnorm', compounds, maps([['AAAAAAAAAA', 'BULK111']]) as never);
        expect(compounds[0].external_ids).toMatchObject({ rxcui: 'BULK111' });
        expect(compounds[1].external_ids).toMatchObject({ rxcui: 'REST999' });
        expect(resolveByUnii).toHaveBeenCalledTimes(1);
        expect(resolveByUnii).toHaveBeenCalledWith('ZZZZZZZZZZ');
        expect(r.stamped).toBe(2);  // 1 bulk + 1 REST
    });

    it('skips REST entirely when the bulk pre-pass clears all eligible', async () => {
        const compounds = [mkCompound('sciweon::compound::CID:3', { external_ids: { unii: 'AAAAAAAAAA' } })];
        const r = await backfillOneSource('rxnorm', compounds, maps([['AAAAAAAAAA', 'BULK111']]) as never);
        expect(r.stamped).toBe(1);
        expect(resolveByUnii).not.toHaveBeenCalled();
    });

    it('fail-soft: no bulkMaps -> pre-pass skipped, REST drain unchanged (parity)', async () => {
        vi.mocked(resolveByUnii).mockResolvedValue({ rxcui: 'REST999' });
        const compounds = [mkCompound('sciweon::compound::CID:4', { external_ids: { unii: 'AAAAAAAAAA' } })];
        const r = await backfillOneSource('rxnorm', compounds);  // no maps
        expect(compounds[0].external_ids).toMatchObject({ rxcui: 'REST999' });
        expect(resolveByUnii).toHaveBeenCalledTimes(1);
        expect(r.stamped).toBe(1);
    });
});

describe('backfillOneSource (openfda_faers)', () => {
    it('stamps fda_signals.faers_top_adr_terms on UNII-bearing records', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue([
            { term: 'HEADACHE', count: 100 },
            { term: 'NAUSEA', count: 50 },
        ]);
        const compounds = [
            mkCompound('sciweon::compound::CID:5', { external_ids: { unii: 'U1' } }),
        ];
        const r = await backfillOneSource('openfda_faers', compounds);
        expect(r.processed).toBe(1);
        expect(r.stamped).toBe(1);
        expect(compounds[0].fda_signals).toMatchObject({
            faers_top_adr_terms: expect.arrayContaining([{ term: 'HEADACHE', count: 100 }]),
            faers_total_top_count: 150,
        });
    });

    it('stamps empty array when adapter returns no signals (records the negative outcome)', async () => {
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue([]);
        const compounds = [mkCompound('sciweon::compound::CID:6', { external_ids: { unii: 'U2' } })];
        const r = await backfillOneSource('openfda_faers', compounds);
        // r.stamped uses isEligible round-trip: after stamping with empty
        // array, isEligible returns false (terms array is now present).
        expect(r.stamped).toBe(1);
        expect(compounds[0].fda_signals.faers_top_adr_terms).toEqual([]);
        expect(compounds[0].fda_signals.faers_total_top_count).toBe(0);
    });
});

describe('integration: per-source error isolation', () => {
    it('one source error does not block subsequent sources (main loop semantics)', async () => {
        // Simulated by calling backfillOneSource sequentially and verifying
        // each returns independent {error} status.
        vi.mocked(fetchByInchiKey).mockRejectedValue(new Error('boom'));
        vi.mocked(resolveByUnii).mockResolvedValue({ rxcui: '1' });
        const compounds = [
            mkCompound('sciweon::compound::CID:1'),
            mkCompound('sciweon::compound::CID:2', { external_ids: { unii: 'Z' } }),
        ];
        const r1 = await backfillOneSource('unichem', compounds);
        const r2 = await backfillOneSource('rxnorm', compounds);
        expect(r1.error).toMatch(/boom/);
        expect(r2.error).toBe(null);
        expect(r2.stamped).toBe(1);
    });
});
