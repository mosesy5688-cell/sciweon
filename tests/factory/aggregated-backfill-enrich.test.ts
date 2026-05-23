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

    it('enriches eligible records with chunk_size cap', async () => {
        vi.mocked(readCursor).mockResolvedValue({ source: 'unichem', cursor_id: null, chunk_size: 2 } as never);
        vi.mocked(fetchByInchiKey).mockResolvedValue({ unii: 'XYZ' });
        const compounds = [
            mkCompound('sciweon::compound::CID:10'),
            mkCompound('sciweon::compound::CID:20'),
            mkCompound('sciweon::compound::CID:30'),
        ];
        const r = await backfillOneSource('unichem', compounds);
        expect(r.processed).toBe(2);
        expect(r.stamped).toBe(2);
        expect(fetchByInchiKey).toHaveBeenCalledTimes(2);
        expect(writeCursor).toHaveBeenCalled();
        const [, cursor] = vi.mocked(writeCursor).mock.calls[0];
        expect(cursor.cursor_id).toBe('sciweon::compound::CID:20');
    });

    it('writes cursor even on mid-chunk adapter failure (D8)', async () => {
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
        expect(r.processed).toBe(2);
        // Cursor must be written even though chunk aborted
        expect(writeCursor).toHaveBeenCalled();
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
