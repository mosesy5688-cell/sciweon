/**
 * Tests for V0.5.6 stage-1 incremental-worker cursor-advance decision.
 *
 * Anchored in [[feedback_cross_cycle_silent_data_loss]] Pattern A. The
 * worker previously advanced the cursor unconditionally after
 * fetchIncremental, even if 0 records returned. Adapter pagination edge
 * cases / transient blips could slide the cursor past a window of data
 * that the adapter believed existed — creating a permanent gap.
 *
 * `decideCursorAdvance` is a pure function. Cursor R2 write is in
 * incremental-cursors.js and is exercised by the worker integration path.
 */

import { describe, it, expect } from 'vitest';
import { decideCursorAdvance } from '../../scripts/factory/lib/incremental-cursor-decision.js';

describe('decideCursorAdvance', () => {
    it('anomaly_zero_fetch_hold: recordsLength === 0 holds cursor at currentSinceToken', () => {
        const d = decideCursorAdvance({
            recordsLength: 0,
            currentSinceToken: '2026-05-18T00:00:00Z',
            nextSinceToken: '2026-05-19T00:00:00Z',
            source: 'dailymed',
        });
        expect(d.kind).toBe('anomaly_zero_fetch_hold');
        expect(d.cursorUpdate.sinceToken).toBe('2026-05-18T00:00:00Z');
        expect(d.cursorUpdate.status).toBe('anomaly_zero_fetch');
        expect(d.cursorUpdate.record_count).toBe(0);
    });

    it('advance: typical non-zero records updates cursor to nextSinceToken', () => {
        const d = decideCursorAdvance({
            recordsLength: 100,
            currentSinceToken: '2026-05-18T00:00:00Z',
            nextSinceToken: '2026-05-19T00:00:00Z',
            source: 'dailymed',
        });
        expect(d.kind).toBe('advance');
        expect(d.cursorUpdate.sinceToken).toBe('2026-05-19T00:00:00Z');
        expect(d.cursorUpdate.status).toBe('success');
        expect(d.cursorUpdate.record_count).toBe(100);
    });

    it('advance: boundary recordsLength=1 advances normally', () => {
        const d = decideCursorAdvance({
            recordsLength: 1,
            currentSinceToken: 't0',
            nextSinceToken: 't1',
            source: 'pubmed',
        });
        expect(d.kind).toBe('advance');
        expect(d.cursorUpdate.sinceToken).toBe('t1');
    });

    it('anomaly message contains the source name (operator log-grep)', () => {
        const d = decideCursorAdvance({
            recordsLength: 0,
            currentSinceToken: 't0',
            nextSinceToken: 't1',
            source: 'clinicaltrials',
        });
        expect(d.message).toContain('clinicaltrials');
    });

    it('anomaly message references "Pattern A" to link to memory chain', () => {
        const d = decideCursorAdvance({
            recordsLength: 0,
            currentSinceToken: 't0',
            nextSinceToken: 't1',
            source: 'openalex',
        });
        expect(d.message).toContain('Pattern A');
    });

    it('anomaly hold even when currentSinceToken === nextSinceToken (defensive)', () => {
        // Some adapters may return nextSinceToken === sinceToken when nothing new;
        // we still treat zero-records-after-hasUpdates as anomaly.
        const d = decideCursorAdvance({
            recordsLength: 0,
            currentSinceToken: 'same-token',
            nextSinceToken: 'same-token',
            source: 'chembl',
        });
        expect(d.kind).toBe('anomaly_zero_fetch_hold');
        expect(d.cursorUpdate.sinceToken).toBe('same-token');
    });

    it('advance carries through null currentSinceToken (first ever run with records)', () => {
        const d = decideCursorAdvance({
            recordsLength: 50,
            currentSinceToken: null,
            nextSinceToken: '2026-05-19T00:00:00Z',
            source: 'pubchem',
        });
        expect(d.kind).toBe('advance');
        expect(d.cursorUpdate.sinceToken).toBe('2026-05-19T00:00:00Z');
    });

    // Cycle 21 — Pattern A2 (probe-path early exit must not trust adapter
    // nextSinceToken). DailyMed/WHO-ATC returned today, poisoning the
    // cursor and permanently locking the source. The SSoT must symmetrize
    // the hold-on-no-progress rule across both branches.
    describe('no_updates_hold (Pattern A2)', () => {
        it('hasUpdates=false holds cursor at currentSinceToken, ignores adapter nextSinceToken', () => {
            const d = decideCursorAdvance({
                recordsLength: 0,
                currentSinceToken: '2026-05-15',
                nextSinceToken: '2026-05-22', // poisoned value adapter returns
                source: 'dailymed',
                hasUpdates: false,
            });
            expect(d.kind).toBe('no_updates_hold');
            expect(d.cursorUpdate.sinceToken).toBe('2026-05-15');
            expect(d.cursorUpdate.status).toBe('no_updates');
            expect(d.cursorUpdate.record_count).toBe(0);
        });

        it('no_updates_hold message references Pattern A2 + source name', () => {
            const d = decideCursorAdvance({
                recordsLength: 0,
                currentSinceToken: '2026-05-15',
                nextSinceToken: '2026-05-22',
                source: 'who-atc',
                hasUpdates: false,
            });
            expect(d.message).toContain('Pattern A2');
            expect(d.message).toContain('who-atc');
        });

        it('hasUpdates=false with null currentSinceToken (first-ever run, no probe data) holds null', () => {
            const d = decideCursorAdvance({
                recordsLength: 0,
                currentSinceToken: null,
                nextSinceToken: '2026-05-22',
                source: 'dailymed',
                hasUpdates: false,
            });
            expect(d.kind).toBe('no_updates_hold');
            expect(d.cursorUpdate.sinceToken).toBeNull();
        });

        it('hasUpdates defaults to true → back-compat with existing fetchIncremental callers', () => {
            const d = decideCursorAdvance({
                recordsLength: 100,
                currentSinceToken: 't0',
                nextSinceToken: 't1',
                source: 'pubmed',
            });
            expect(d.kind).toBe('advance');
        });

        it('hasUpdates=true + zero records still routes to anomaly_zero_fetch_hold (Pattern A unchanged)', () => {
            const d = decideCursorAdvance({
                recordsLength: 0,
                currentSinceToken: 't0',
                nextSinceToken: 't1',
                source: 'chembl',
                hasUpdates: true,
            });
            expect(d.kind).toBe('anomaly_zero_fetch_hold');
            expect(d.cursorUpdate.status).toBe('anomaly_zero_fetch');
        });
    });
});
