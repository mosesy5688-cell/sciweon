// @ts-nocheck
/**
 * P-8 GAP-B — hard FAERS record cap in drainAdapterBacklog + stop_reason set.
 *
 * Covers WO scenarios (5) max=8000 never processes the 8001st record;
 * (6) max < DEFAULT_BACKFILL_CHUNK -> no overrun; (7) time budget exhausts
 * first -> TIME_BUDGET_REACHED; (8) backlog exhausts first -> BACKLOG_EXHAUSTED;
 * plus the effective_chunk pre-check invariant + the full stop_reason vocabulary.
 */

import { describe, it, expect } from 'vitest';
import { chunkIterator } from '../../scripts/factory/lib/enrichment-cursor.js';
import {
    drainAdapterBacklog, STOP_REASON, parseMaxRecordsEnv, buildDrainEvidence,
} from '../../scripts/factory/lib/drain-adapter-backlog.js';
import { makeMockRecords, makeMockEnrichOne } from './helpers/drain-test-fixtures.js';

describe('P-8 GAP-B: hard record cap never overshoots', () => {
    it('(5) max=8000 over a 12000 backlog -> processes EXACTLY 8000, never the 8001st', async () => {
        const eligible = makeMockRecords(12000);
        let maxSeenIndex = -1;
        const enrichOne = async (r) => {
            const idx = Number(r.id.split('::').pop());
            if (idx > maxSeenIndex) maxSeenIndex = idx;
            r.enriched = true;
        };
        const result = await drainAdapterBacklog({
            eligible, enrichOne, chunkIterator, chunkSize: 2000,
            timeBudgetMs: 600_000, coldStartEstimateMs: 1, sleepMsBetween: 0,
            initialCursor: null, logEveryNRecords: 0, maxRecords: 8000,
        });
        expect(result.processedInRun).toBe(8000);
        expect(result.stopReason).toBe(STOP_REASON.MAX_RECORDS_REACHED);
        // Exactly 8000 records enriched (the 8001st was never touched).
        expect(eligible.filter(r => r.enriched).length).toBe(8000);
        expect(result.remainingBacklog).toBe(4000);
    });

    it('(6) max=2500 with a 2000 chunk (non-multiple) -> processes EXACTLY 2500, no overrun', async () => {
        const eligible = makeMockRecords(10000);
        const result = await drainAdapterBacklog({
            eligible, enrichOne: makeMockEnrichOne(), chunkIterator, chunkSize: 2000,
            timeBudgetMs: 600_000, coldStartEstimateMs: 1, sleepMsBetween: 0,
            initialCursor: null, logEveryNRecords: 0, maxRecords: 2500,
        });
        expect(result.processedInRun).toBe(2500);
        expect(result.stopReason).toBe(STOP_REASON.MAX_RECORDS_REACHED);
        expect(eligible.filter(r => r.enriched).length).toBe(2500);
    });

    it('(6b) max=500 < chunkSize(2000) -> first chunk clamps to 500, never overshoots', async () => {
        const eligible = makeMockRecords(5000);
        const result = await drainAdapterBacklog({
            eligible, enrichOne: makeMockEnrichOne(), chunkIterator, chunkSize: 2000,
            timeBudgetMs: 600_000, coldStartEstimateMs: 1, sleepMsBetween: 0,
            initialCursor: null, logEveryNRecords: 0, maxRecords: 500,
        });
        expect(result.processedInRun).toBe(500);
        expect(result.chunksDrained).toBe(1);
        expect(result.stopReason).toBe(STOP_REASON.MAX_RECORDS_REACHED);
    });

    it('cap >= backlog -> backlog exhausts first (cap not the binding limit)', async () => {
        const eligible = makeMockRecords(3000);
        const result = await drainAdapterBacklog({
            eligible, enrichOne: makeMockEnrichOne(), chunkIterator, chunkSize: 1000,
            timeBudgetMs: 600_000, coldStartEstimateMs: 1, sleepMsBetween: 0,
            initialCursor: null, logEveryNRecords: 0, maxRecords: 8000,
        });
        expect(result.processedInRun).toBe(3000);
        expect(result.stopReason).toBe(STOP_REASON.BACKLOG_EXHAUSTED);
        expect(result.remainingBacklog).toBe(0);
    });

    it('max=0 -> immediate stop, zero records processed', async () => {
        const eligible = makeMockRecords(1000);
        const result = await drainAdapterBacklog({
            eligible, enrichOne: makeMockEnrichOne(), chunkIterator, chunkSize: 1000,
            timeBudgetMs: 600_000, coldStartEstimateMs: 1, sleepMsBetween: 0,
            initialCursor: null, logEveryNRecords: 0, maxRecords: 0,
        });
        expect(result.processedInRun).toBe(0);
        expect(result.stopReason).toBe(STOP_REASON.MAX_RECORDS_REACHED);
        expect(eligible.every(r => !r.enriched)).toBe(true);
    });
});

describe('P-8 GAP-B: time budget remains a SECOND cap', () => {
    it('(7) time budget exhausts before the record cap -> TIME_BUDGET_REACHED', async () => {
        // 5000 records, cap 5000 (non-binding), each chunk ~50ms; budget too small
        // for the full drain so time stops it first with a generous record cap.
        const eligible = makeMockRecords(5000);
        const enrichOne = async (r) => { await new Promise(res => setTimeout(res, 0)); r.enriched = true; };
        const result = await drainAdapterBacklog({
            eligible, enrichOne, chunkIterator, chunkSize: 1000,
            timeBudgetMs: 5, coldStartEstimateMs: 50, sleepMsBetween: 0,
            initialCursor: null, logEveryNRecords: 0, maxRecords: 5000,
        });
        expect(result.stopReason).toBe(STOP_REASON.TIME_BUDGET_REACHED);
        expect(result.processedInRun).toBeLessThan(5000);
    });
});

describe('P-8 GAP-B: no cap = today behavior (BACKLOG_EXHAUSTED)', () => {
    it('(8) unset maxRecords -> full drain, BACKLOG_EXHAUSTED', async () => {
        const eligible = makeMockRecords(4000);
        const result = await drainAdapterBacklog({
            eligible, enrichOne: makeMockEnrichOne(), chunkIterator, chunkSize: 1000,
            timeBudgetMs: 600_000, coldStartEstimateMs: 1, sleepMsBetween: 0,
            initialCursor: null, logEveryNRecords: 0, // maxRecords omitted
        });
        expect(result.processedInRun).toBe(4000);
        expect(result.stopReason).toBe(STOP_REASON.BACKLOG_EXHAUSTED);
    });

    it('empty eligible -> BACKLOG_EXHAUSTED (clean)', async () => {
        const result = await drainAdapterBacklog({
            eligible: [], enrichOne: makeMockEnrichOne(), chunkIterator, chunkSize: 1000,
            timeBudgetMs: 600_000, coldStartEstimateMs: 1, sleepMsBetween: 0, initialCursor: null,
        });
        expect(result.stopReason).toBe(STOP_REASON.BACKLOG_EXHAUSTED);
    });
});

describe('P-8 GAP-B: stop_reason vocabulary + helpers', () => {
    it('STOP_REASON has exactly the five canonical reasons', () => {
        expect(Object.values(STOP_REASON).sort()).toEqual([
            'BACKLOG_EXHAUSTED', 'INVARIANT_FAILURE', 'MAX_RECORDS_REACHED',
            'SOURCE_FAILURE', 'TIME_BUDGET_REACHED',
        ]);
    });

    it('invalid maxRecords (negative / non-integer) throws', async () => {
        await expect(drainAdapterBacklog({
            eligible: makeMockRecords(10), enrichOne: makeMockEnrichOne(), chunkIterator,
            chunkSize: 5, timeBudgetMs: 1000, coldStartEstimateMs: 1, sleepMsBetween: 0,
            initialCursor: null, maxRecords: -5,
        })).rejects.toThrow(/non-negative integer/);
    });

    it('parseMaxRecordsEnv: unset/blank -> null; valid -> int; bad -> throws', () => {
        delete process.env.__P8_T;
        expect(parseMaxRecordsEnv('__P8_T')).toBeNull();
        process.env.__P8_T = '8000';
        expect(parseMaxRecordsEnv('__P8_T')).toBe(8000);
        process.env.__P8_T = 'oops';
        expect(() => parseMaxRecordsEnv('__P8_T')).toThrow(/invalid/);
        delete process.env.__P8_T;
    });

    it('buildDrainEvidence emits the full evidence shape', () => {
        const e = buildDrainEvidence({
            requestedMaxRecords: 8000, stampedThisRun: 12, attemptedThisRun: 8000,
            remainingBacklog: 4000, stopReason: STOP_REASON.MAX_RECORDS_REACHED,
            cursorBefore: 'c0', cursorAfter: 'c1',
        });
        expect(e).toEqual({
            requested_max_records: 8000, stamped_this_run: 12, attempted_this_run: 8000,
            remaining_backlog: 4000, stop_reason: 'MAX_RECORDS_REACHED',
            cursor_before: 'c0', cursor_after: 'c1',
        });
    });
});
