/**
 * Tests for V0.5.5 stage-4 historical-comparison gate decision logic.
 *
 * Anchored in [[feedback_cross_cycle_silent_data_loss]] — defense-in-depth
 * for the 2026-05-18 -83% regression scenario:
 *   - 5000-record snapshot overwrote 29994-record healthy snapshot
 *   - Existing `verifyNonEmpty` (>100 bytes) sailed through
 *   - This gate catches it via historical (manifest-vs-current) comparison
 *
 * `decideGateAction` is a pure function. R2 manifest I/O is integration-
 * tested separately (this file covers the decision logic only).
 */

import { describe, it, expect } from 'vitest';
import { decideGateAction } from '../../scripts/factory/lib/snapshot-history-gate.js';

describe('decideGateAction', () => {
    it('skip_no_previous: previousRecords null (first-ever publish)', () => {
        const action = decideGateAction({
            currentRecords: 5000,
            previousRecords: null,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('skip_no_previous');
    });

    it('skip_no_previous: previousRecords undefined', () => {
        const action = decideGateAction({
            currentRecords: 5000,
            previousRecords: undefined,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('skip_no_previous');
    });

    it('skip_no_previous: previousRecords 0 (edge case, treat as no baseline)', () => {
        const action = decideGateAction({
            currentRecords: 5000,
            previousRecords: 0,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('skip_no_previous');
    });

    it('abort_regression: 83% drop (the 2026-05-18 production regression)', () => {
        // The actual numbers from the audit: 29994 → 5000 = ~83% drop
        const action = decideGateAction({
            currentRecords: 5000,
            previousRecords: 29994,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('abort_regression');
        expect(action.dropPct).toBeGreaterThan(83);
        expect(action.dropPct).toBeLessThan(84);
    });

    it('abort_regression: exactly threshold + epsilon', () => {
        // 31% drop with 30% threshold → abort
        const action = decideGateAction({
            currentRecords: 69,
            previousRecords: 100,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('abort_regression');
        expect(action.dropPct).toBe(31);
    });

    it('pass: exactly at threshold (30% drop, not > 30%)', () => {
        const action = decideGateAction({
            currentRecords: 70,
            previousRecords: 100,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('pass');
        expect(action.dropPct).toBe(30);
    });

    it('pass: typical incremental growth', () => {
        // Cumulative pipeline grows ~5% per day
        const action = decideGateAction({
            currentRecords: 31200,
            previousRecords: 30000,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('pass');
        expect(action.dropPct).toBeLessThan(0);  // negative = growth
    });

    it('pass: small legitimate drop (5%) within threshold', () => {
        const action = decideGateAction({
            currentRecords: 28500,
            previousRecords: 30000,
            thresholdPct: 30,
        });
        expect(action.kind).toBe('pass');
        expect(action.dropPct).toBe(5);
    });

    it('tunable threshold: higher pct allows larger drop', () => {
        const action = decideGateAction({
            currentRecords: 5000,
            previousRecords: 29994,
            thresholdPct: 90,  // legitimate large cleanup allowed
        });
        expect(action.kind).toBe('pass');
    });
});
