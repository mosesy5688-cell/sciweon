/**
 * Tests for V0.5.6 loadPreviousAggregated error classifier.
 *
 * Anchored in [[feedback_cross_cycle_silent_data_loss]] Pattern A.
 * Previous bare `catch {}` in `loadPreviousAggregated` returned empty Map
 * on every failure mode (orphaned pointer, network error, gzip / JSON
 * corruption). Stage-3 then silently merged against an empty baseline
 * and clobbered cumulative state. The classifier separates the single
 * legitimate "first run" case from every error that must surface.
 *
 * Pure function. S3 client wiring is in incremental-merge-helpers.js
 * integration code path.
 */

import { describe, it, expect } from 'vitest';
import { classifyPreviousAggregatedError } from '../../scripts/factory/lib/aggregated-error-classify.js';

describe('classifyPreviousAggregatedError', () => {
    it('pointer 404 by err.name = NoSuchKey → first_run', () => {
        const err = Object.assign(new Error('not found'), { name: 'NoSuchKey' });
        const c = classifyPreviousAggregatedError(err, 'pointer');
        expect(c.kind).toBe('first_run');
    });

    it('pointer 404 by $metadata.httpStatusCode = 404 → first_run', () => {
        const err = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
        const c = classifyPreviousAggregatedError(err, 'pointer');
        expect(c.kind).toBe('first_run');
    });

    it('data 404 by err.name = NoSuchKey → orphaned_pointer', () => {
        const err = Object.assign(new Error('not found'), { name: 'NoSuchKey' });
        const c = classifyPreviousAggregatedError(err, 'data');
        expect(c.kind).toBe('orphaned_pointer');
    });

    it('data 404 by $metadata.httpStatusCode = 404 → orphaned_pointer', () => {
        const err = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
        const c = classifyPreviousAggregatedError(err, 'data');
        expect(c.kind).toBe('orphaned_pointer');
    });

    it('pointer network error (no 404 indicator) → transient_or_corrupted with original message', () => {
        const err = Object.assign(new Error('ECONNRESET'), {
            name: 'NetworkingError',
            $metadata: { httpStatusCode: 503 },
        });
        const c = classifyPreviousAggregatedError(err, 'pointer');
        expect(c.kind).toBe('transient_or_corrupted');
        expect(c.message).toContain('pointer');
        expect(c.message).toContain('ECONNRESET');
    });

    it('JSON parse error (SyntaxError) on pointer stage → transient_or_corrupted', () => {
        // Real-world: pointer object exists but body isn't valid JSON
        const err = new SyntaxError('Unexpected token < in JSON at position 0');
        const c = classifyPreviousAggregatedError(err, 'pointer');
        expect(c.kind).toBe('transient_or_corrupted');
        expect(c.message).toContain('Unexpected token');
    });

    it('orphaned_pointer message contains "manual investigation required" (operator log-grep)', () => {
        const err = Object.assign(new Error('not found'), { name: 'NoSuchKey' });
        const c = classifyPreviousAggregatedError(err, 'data');
        expect(c.message).toContain('manual investigation required');
    });

    it('non-Error throw value (string) on data stage → transient_or_corrupted', () => {
        // Defensive: some code paths reject with non-Error values
        const c = classifyPreviousAggregatedError('raw string error', 'data');
        expect(c.kind).toBe('transient_or_corrupted');
        expect(c.message).toContain('raw string error');
    });
});
