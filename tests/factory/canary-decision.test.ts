/**
 * Tests for V0.5.8 Wave I-5 — source canary decision helper.
 *
 * Pure decision: given prev adapter state + current probe result + threshold,
 * returns the kind of action the workflow should take (open/close/no-op Issue).
 */

import { describe, it, expect } from 'vitest';
import {
    decideCanaryAction,
    DEFAULT_THRESHOLD,
} from '../../scripts/factory/lib/canary-decision.js';

describe('decideCanaryAction', () => {
    it('null prev + curr.passed=true -> healthy (first ever run, ok)', () => {
        const d = decideCanaryAction(null, { passed: true, duration_ms: 100 });
        expect(d.kind).toBe('healthy');
        expect(d.next.consecutive_failures).toBe(0);
        expect(d.next.last_status).toBe('pass');
        expect(d.next.last_success_at).toBeTruthy();
    });

    it('null prev + curr.passed=false -> first_failure (do not Issue on first)', () => {
        const d = decideCanaryAction(null, { passed: false, error: 'API timeout', duration_ms: 20000 });
        expect(d.kind).toBe('first_failure');
        expect(d.next.consecutive_failures).toBe(1);
        expect(d.next.last_error).toBe('API timeout');
    });

    it('prev fails=1 + curr.passed=false + threshold=2 -> newly_failing (just crossed)', () => {
        const prev = { consecutive_failures: 1, last_status: 'fail' };
        const d = decideCanaryAction(prev, { passed: false, error: 'HTTP 500' }, 2);
        expect(d.kind).toBe('newly_failing');
        expect(d.next.consecutive_failures).toBe(2);
    });

    it('prev fails=3 + curr.passed=false + threshold=2 -> still_failing (already issued)', () => {
        const prev = { consecutive_failures: 3, last_status: 'fail' };
        const d = decideCanaryAction(prev, { passed: false, error: 'still down' }, 2);
        expect(d.kind).toBe('still_failing');
        expect(d.next.consecutive_failures).toBe(4);
    });

    it('prev fails=3 + curr.passed=true + threshold=2 -> recovered', () => {
        const prev = { consecutive_failures: 3, last_status: 'fail', last_failure_at: '2026-05-17T...' };
        const d = decideCanaryAction(prev, { passed: true, duration_ms: 250 }, 2);
        expect(d.kind).toBe('recovered');
        expect(d.next.consecutive_failures).toBe(0);
        expect(d.next.last_status).toBe('pass');
    });

    it('prev fails=0 + curr.passed=true -> healthy (continuing happy path)', () => {
        const prev = { consecutive_failures: 0, last_status: 'pass' };
        const d = decideCanaryAction(prev, { passed: true, duration_ms: 200 });
        expect(d.kind).toBe('healthy');
        expect(d.next.consecutive_failures).toBe(0);
    });

    it('custom threshold=3: need 3 consecutive failures to cross', () => {
        // prev=2 fails + curr fail -> 3 fails, threshold=3 -> newly_failing
        const d2 = decideCanaryAction({ consecutive_failures: 2, last_status: 'fail' }, { passed: false, error: 'x' }, 3);
        expect(d2.kind).toBe('newly_failing');
        // prev=1 + curr fail = 2 fails, still under 3-threshold -> first_failure (subthreshold)
        const d1 = decideCanaryAction({ consecutive_failures: 1, last_status: 'fail' }, { passed: false, error: 'x' }, 3);
        expect(d1.kind).toBe('first_failure');
    });

    it('preserves prior last_success_at on failure transition', () => {
        const prev = { consecutive_failures: 0, last_status: 'pass', last_success_at: '2026-05-18T12:00:00Z' };
        const d = decideCanaryAction(prev, { passed: false, error: 'down' });
        expect(d.next.last_success_at).toBe('2026-05-18T12:00:00Z');
    });

    it('DEFAULT_THRESHOLD is 2', () => {
        expect(DEFAULT_THRESHOLD).toBe(2);
    });
});
