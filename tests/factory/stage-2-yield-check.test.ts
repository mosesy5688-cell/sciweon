/**
 * Tests for V0.5.6 stage-2 per-enricher yield-check decision logic.
 *
 * Anchored in [[feedback_cross_cycle_silent_data_loss]] — Pattern A 3rd
 * occurrence. stage-2 enrichers mutate compounds-enriched.jsonl / bioactivities.jsonl
 * in place; a buggy enricher can exit 0 yet leave the file empty. Before this
 * gate, stage-2 would still upload the empty bundle to R2 and downstream stages
 * would see "no input".
 *
 * `decideYieldAction` is a pure function. File-counting (`countJsonlRecords`)
 * is exercised by the snapshot-history-gate integration tests; this file
 * covers the decision logic only.
 */

import { describe, it, expect } from 'vitest';
import { decideYieldAction } from '../../scripts/factory/lib/stage-2-yield.js';

describe('decideYieldAction', () => {
    it('zero_records_abort: currentRecords === 0 triggers abort', () => {
        const action = decideYieldAction({
            currentRecords: 0,
            taskName: 'fingerprint',
            yieldFile: './output/linked/compounds-enriched.jsonl',
        });
        expect(action.kind).toBe('zero_records_abort');
        expect(action.message).toBeTypeOf('string');
    });

    it('pass: typical non-zero record count', () => {
        const action = decideYieldAction({
            currentRecords: 100,
            taskName: 'compound-id-resolver',
            yieldFile: './output/linked/compounds-enriched.jsonl',
        });
        expect(action.kind).toBe('pass');
        expect(action.currentRecords).toBe(100);
    });

    it('pass: boundary — currentRecords === 1 (smallest non-zero)', () => {
        const action = decideYieldAction({
            currentRecords: 1,
            taskName: 'fda',
            yieldFile: './output/linked/compounds-enriched.jsonl',
        });
        expect(action.kind).toBe('pass');
        expect(action.currentRecords).toBe(1);
    });

    it('pass: realistic compound-count scale (~50k records)', () => {
        const action = decideYieldAction({
            currentRecords: 50000,
            taskName: 'compound-faers',
            yieldFile: './output/linked/compounds-enriched.jsonl',
        });
        expect(action.kind).toBe('pass');
        expect(action.currentRecords).toBe(50000);
    });

    it('abort message: includes the task name (operator must identify the failing enricher)', () => {
        const action = decideYieldAction({
            currentRecords: 0,
            taskName: 'adapter-cross-linker',
            yieldFile: './output/linked/compounds-enriched.jsonl',
        });
        expect(action.message).toContain('adapter-cross-linker');
    });

    it('abort message: includes the yield file path (operator must correlate to disk state)', () => {
        const action = decideYieldAction({
            currentRecords: 0,
            taskName: 'target-resolver',
            yieldFile: './output/linked/bioactivities.jsonl',
        });
        expect(action.message).toContain('./output/linked/bioactivities.jsonl');
    });

    it('abort message: references "Pattern A" to link to the feedback memory chain', () => {
        const action = decideYieldAction({
            currentRecords: 0,
            taskName: 'kegg',
            yieldFile: './output/linked/compounds-enriched.jsonl',
        });
        expect(action.message).toContain('Pattern A');
    });
});
