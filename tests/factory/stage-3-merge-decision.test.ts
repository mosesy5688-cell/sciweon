/**
 * Tests for V0.5.5 stage-3 cumulative-merge decision logic.
 *
 * Anchored in [[feedback_cross_cycle_silent_data_loss]] — these tests
 * guard against the 2026-05-18 production regression mode:
 *   - V0.5.2.1 had silent-skip clause `prevPointer.run_id === runId`
 *     that fired in legitimate happy-path conditions and clobbered
 *     cumulative state with current-cycle-only data.
 *   - Root cause audit found *second* mode: latest.json pointing at
 *     partially-written bundle (mid-upload crash) → empty buffers →
 *     merge-against-empty → silent clobber.
 *
 * `decideMergeAction` is a pure function (no R2 deps) covering all
 * 5 branches. R2 sentinel I/O is tested separately via integration
 * (this file covers the decision logic only).
 */

import { describe, it, expect } from 'vitest';
import { decideMergeAction } from '../../scripts/factory/lib/aggregated-sentinel.js';

describe('decideMergeAction', () => {
    it('first_run_skip: no sentinel, no pointer (legitimate bootstrap)', () => {
        expect(decideMergeAction({
            prevPointer: null,
            runId: 'r1',
            firstRunDone: false,
            prevBufferNonEmpty: false,
        })).toEqual({ kind: 'first_run_skip' });
    });

    it('sentinel_present_pointer_missing: sentinel exists but pointer gone (operator surgery — abort)', () => {
        expect(decideMergeAction({
            prevPointer: null,
            runId: 'r1',
            firstRunDone: true,
            prevBufferNonEmpty: false,
        })).toEqual({ kind: 'sentinel_present_pointer_missing' });
    });

    it('same_run_skip: pointer references current runId (workflow_dispatch re-run)', () => {
        expect(decideMergeAction({
            prevPointer: { run_id: 'r1' },
            runId: 'r1',
            firstRunDone: true,
            prevBufferNonEmpty: true,
        })).toEqual({ kind: 'same_run_skip' });
    });

    it('empty_buffer_abort: pointer valid but buffer empty (partial upload crash — abort)', () => {
        expect(decideMergeAction({
            prevPointer: { run_id: 'r0' },
            runId: 'r1',
            firstRunDone: true,
            prevBufferNonEmpty: false,
        })).toEqual({ kind: 'empty_buffer_abort' });
    });

    it('merge: happy path (sentinel set, pointer valid, buffer non-empty)', () => {
        expect(decideMergeAction({
            prevPointer: { run_id: 'r0' },
            runId: 'r1',
            firstRunDone: true,
            prevBufferNonEmpty: true,
        })).toEqual({ kind: 'merge' });
    });

    it('merge: legacy bootstrap (existing V0.5.2.1 deployment, no sentinel but valid pointer + buffer)', () => {
        // Backwards-compat: a deployment that ran V0.5.2.1 has valid R2 state
        // but never wrote the sentinel. First V0.5.5 run should merge happily
        // and write sentinel after upload — NOT abort as "sentinel missing".
        expect(decideMergeAction({
            prevPointer: { run_id: 'r0' },
            runId: 'r1',
            firstRunDone: false,
            prevBufferNonEmpty: true,
        })).toEqual({ kind: 'merge' });
    });

    it('empty_buffer_abort: legacy bootstrap with empty previous (rare but possible)', () => {
        // Edge case: legacy deployment + partial upload crash before V0.5.5
        // upgrade. We still want to abort, not silently merge against empty.
        expect(decideMergeAction({
            prevPointer: { run_id: 'r0' },
            runId: 'r1',
            firstRunDone: false,
            prevBufferNonEmpty: false,
        })).toEqual({ kind: 'empty_buffer_abort' });
    });

    it('pointer_missing_run_id: foreign-writer latest.json without run_id (manual R2 rollback) — abort', () => {
        // 2026-05-19 F3 regression: user did manual R2 PutObject rollback
        // writing a latest.json body that lacked the run_id field. Original
        // decideMergeAction fell through to merge → crash → silent 5000-record
        // upload. New branch hard-aborts on this schema.
        expect(decideMergeAction({
            prevPointer: { latest_snapshot_date: '2026-05-17' },
            runId: 'r1',
            firstRunDone: true,
            prevBufferNonEmpty: false,
        })).toEqual({ kind: 'pointer_missing_run_id' });
    });

    it('pointer_missing_run_id: malformed pointer aborts even if buffer would have been non-empty', () => {
        // Branch must win over merge regardless of buffer state — a partial
        // pointer schema is untrustworthy and operator must rewrite it.
        expect(decideMergeAction({
            prevPointer: { latest_snapshot_date: '2026-05-17' },
            runId: 'r1',
            firstRunDone: false,
            prevBufferNonEmpty: true,
        })).toEqual({ kind: 'pointer_missing_run_id' });
    });
});
