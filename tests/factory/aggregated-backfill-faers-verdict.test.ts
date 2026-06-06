/**
 * PR-FACTORY3-OPENFDA-KEY tests for aggregated-backfill-enrich.js.
 *
 * Two fixes are asserted here (kept in a SEPARATE file so the original
 * aggregated-backfill-enrich.test.ts stays under the 250-line monolith cap):
 *   1. Verdict de-masking (no-silent-loss): the keyless-openFDA prod bug
 *      returned null for every FAERS record (0 stamps) and was MASKED as
 *      SATURATION_CONFIRMED. The fix flips the verdict to FETCH_FAILURES when
 *      the per-run fetch-error count exceeds FAERS_FETCH_FAILURE_RATIO (0.25)
 *      of records processed, so a keyless failure can never read as benign.
 *   2. Per-source FAERS drain budget: openfda_faers gets the larger 60min
 *      FAERS_DRAIN_BUDGET_MS while unichem/rxnorm keep the shared 25min default.
 *
 * R2 cursor IO + the openFDA adapter are mocked. drainAdapterBacklog is mocked
 * actual-backed (real impl by default; per-test override to inspect call args).
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

vi.mock('../../scripts/factory/lib/drain-adapter-backlog.js', async () => {
    const actual: typeof import('../../scripts/factory/lib/drain-adapter-backlog.js') =
        await vi.importActual('../../scripts/factory/lib/drain-adapter-backlog.js');
    return { ...actual, drainAdapterBacklog: vi.fn(actual.drainAdapterBacklog) };
});

import { readCursor, writeCursor } from '../../scripts/factory/lib/enrichment-cursor.js';
import { fetchFaersSignalsByUnii } from '../../scripts/ingestion/adapters/openfda-adapter.js';
import { drainAdapterBacklog } from '../../scripts/factory/lib/drain-adapter-backlog.js';
import { backfillOneSource } from '../../scripts/factory/aggregated-backfill-enrich.js';

beforeEach(async () => {
    vi.mocked(readCursor).mockReset().mockResolvedValue(null);
    vi.mocked(writeCursor).mockReset().mockResolvedValue(undefined);
    vi.mocked(fetchFaersSignalsByUnii).mockReset();
    const actualDrain: typeof import('../../scripts/factory/lib/drain-adapter-backlog.js') =
        await vi.importActual('../../scripts/factory/lib/drain-adapter-backlog.js');
    vi.mocked(drainAdapterBacklog).mockReset().mockImplementation(actualDrain.drainAdapterBacklog);
});

function mkCompound(id: string, opts: Record<string, unknown> = {}) {
    return { id, inchi_key: `KEY_${id}`, external_ids: opts.external_ids ?? {}, ...opts } as Record<string, unknown>;
}

const NOOP_DRAIN = {
    terminatedBy: 'wrapped', chunksDrained: 1, processedInRun: 3,
    remainingBacklog: 0, finalCursor: null, finalCursorResult: null,
};

function captureBackfillLog(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        lines.push(args.map(String).join(' '));
    });
    return { lines, restore: () => spy.mockRestore() };
}

describe('openfda_faers verdict de-masking (no-silent-loss)', () => {
    it('flips to FETCH_FAILURES when the adapter returns null for every record (keyless openFDA)', async () => {
        // Real drain + real faers enricher; the openFDA adapter mocked to return
        // null (the keyless / error-as-empty sentinel). Each record => 1 fetch
        // error + 0 stamp, so errors == processed (ratio 1.0 > 0.25) => de-mask.
        vi.mocked(fetchFaersSignalsByUnii).mockResolvedValue(null as never);
        const compounds = [
            mkCompound('sciweon::compound::CID:7', { external_ids: { unii: 'K1' } }),
            mkCompound('sciweon::compound::CID:8', { external_ids: { unii: 'K2' } }),
            mkCompound('sciweon::compound::CID:9', { external_ids: { unii: 'K3' } }),
        ];
        const cap = captureBackfillLog();
        const r = await backfillOneSource('openfda_faers', compounds);
        cap.restore();
        const drainDone = cap.lines.find(l => l.includes('Drain done')) ?? '';
        expect(drainDone).toContain('verdict=FETCH_FAILURES');
        expect(drainDone).not.toContain('SATURATION_CONFIRMED');
        expect(drainDone).toContain('check OPENFDA_API_KEY');
        expect(r.stamped).toBe(0);          // nothing stamped (all null)
        expect(r.fetchErrors).toBe(3);      // one fetch error per record
        expect(r.fetchFailureDominant).toBe(true);
    });

    it('a genuine 0-error 0-stamp run still reads SATURATION_CONFIRMED', async () => {
        // Drain mocked to report records processed WITHOUT calling enrichOne (no
        // fetch errors, no stamps) -- the genuine-saturation shape the prior
        // verdict was designed for. fetchErrors=0 => no flip => SATURATION.
        vi.mocked(drainAdapterBacklog).mockResolvedValue(NOOP_DRAIN as never);
        const compounds = [
            mkCompound('sciweon::compound::CID:11', { external_ids: { unii: 'S1' } }),
            mkCompound('sciweon::compound::CID:12', { external_ids: { unii: 'S2' } }),
            mkCompound('sciweon::compound::CID:13', { external_ids: { unii: 'S3' } }),
        ];
        const cap = captureBackfillLog();
        const r = await backfillOneSource('openfda_faers', compounds);
        cap.restore();
        const drainDone = cap.lines.find(l => l.includes('Drain done')) ?? '';
        expect(drainDone).toContain('verdict=SATURATION_CONFIRMED');
        expect(drainDone).not.toContain('FETCH_FAILURES');
        expect(r.fetchErrors).toBe(0);
        expect(r.fetchFailureDominant).toBe(false);
    });
});

describe('openfda_faers per-source drain budget', () => {
    const EMPTY_DRAIN = { ...NOOP_DRAIN, chunksDrained: 0, processedInRun: 0 };

    it('passes the 60min FAERS budget to drainAdapterBacklog for openfda_faers', async () => {
        vi.mocked(drainAdapterBacklog).mockResolvedValue(EMPTY_DRAIN as never);
        const compounds = [mkCompound('sciweon::compound::CID:21', { external_ids: { unii: 'B1' } })];
        await backfillOneSource('openfda_faers', compounds);
        expect(drainAdapterBacklog).toHaveBeenCalledWith(
            expect.objectContaining({ timeBudgetMs: 60 * 60 * 1000 }),
        );
    });

    it('uses the shared 25min default for unichem (not the FAERS budget)', async () => {
        vi.mocked(drainAdapterBacklog).mockResolvedValue(EMPTY_DRAIN as never);
        const compounds = [mkCompound('sciweon::compound::CID:22')];
        await backfillOneSource('unichem', compounds);
        expect(drainAdapterBacklog).toHaveBeenCalledWith(
            expect.objectContaining({ timeBudgetMs: 25 * 60 * 1000 }),
        );
    });
});
