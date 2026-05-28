// @ts-nocheck
/**
 * PR-CORE-DRUG-LABEL-LEAK 2026-05-28: invariant defense for drug-labels.jsonl
 * in stage-3-merger.
 *
 * Triggered by F3 run 26549696523 (cancelled mid-flight to preserve R2 state):
 * F2 emitted drug-labels.jsonl WITHOUT ndcs[] / rxcui[] because fan-in
 * cumulative still carries pre-PR-RXN-1b-pre adapter shape (915 records
 * lack ndcs[]); cross-linker hydration skipped all 915 (labels_hydrated=0).
 * Without this strategy, stage-3-merger's default replace-by-id would have
 * silently overwritten prev's PR-RXN-1b-pre-promote hydrated ndcs[]+rxcui[]
 * with empty F2 cur -- end-to-end SHA256 ebc69f5fba286821... permanently
 * erased.
 *
 * Symmetric to PR-CORE-MERGE-LEAK's deepMergeCompound defense; this is the
 * drug_label axis extension.
 */

import { describe, it, expect } from 'vitest';
import { deepMergeDrugLabel } from '../../scripts/factory/lib/aggregated-deep-merge.js';
import { mergeRecords, MERGE_FILES, MERGE_STRATEGY_PER_FILE } from '../../scripts/factory/lib/aggregated-merger.js';

describe('PR-CORE-DRUG-LABEL-LEAK: deepMergeDrugLabel invariant matrix', () => {
    it('1. Architect lock: cur lacking ndcs/rxcui MUST preserve prev historical hydrated values', () => {
        const prev = {
            id: 'sciweon::drug_label::SETID_1',
            title: 'Aspirin v1',
            ndcs: ['00042022001'],
            rxcui: ['83367'],
        };
        const cur = {
            id: 'sciweon::drug_label::SETID_1',
            title: 'Aspirin v2 (Updated Text)',
            // ndcs + rxcui both absent (F2 unhydrated emit case)
        };
        const merged = deepMergeDrugLabel(prev, cur);
        expect(merged.title).toBe('Aspirin v2 (Updated Text)');  // cur top-level wins
        expect(merged.ndcs).toEqual(['00042022001']);             // prev preserved
        expect(merged.rxcui).toEqual(['83367']);                  // prev preserved
    });

    it('2. cur with non-empty ndcs/rxcui MUST overwrite prev (true freshness path)', () => {
        const prev = { id: 'X', ndcs: ['OLD1'], rxcui: ['IN_OLD'] };
        const cur = { id: 'X', ndcs: ['NEW1', 'NEW2'], rxcui: ['IN_NEW'] };
        const merged = deepMergeDrugLabel(prev, cur);
        expect(merged.ndcs).toEqual(['NEW1', 'NEW2']);
        expect(merged.rxcui).toEqual(['IN_NEW']);
    });

    it('3. cur with empty-array ndcs/rxcui treated as missing (preserve prev)', () => {
        const prev = { id: 'X', ndcs: ['001'], rxcui: ['IN_A'] };
        const cur = { id: 'X', ndcs: [], rxcui: [] };
        const merged = deepMergeDrugLabel(prev, cur);
        expect(merged.ndcs).toEqual(['001']);
        expect(merged.rxcui).toEqual(['IN_A']);
    });

    it('4. asymmetric: cur lacks ndcs but has rxcui -> ndcs preserved, rxcui overwritten', () => {
        const prev = { id: 'X', ndcs: ['001'], rxcui: ['IN_OLD'] };
        const cur = { id: 'X', rxcui: ['IN_NEW'] };
        const merged = deepMergeDrugLabel(prev, cur);
        expect(merged.ndcs).toEqual(['001']);
        expect(merged.rxcui).toEqual(['IN_NEW']);
    });

    it('5. fresh record (prev null) returns current as-is', () => {
        const cur = { id: 'NEW', ndcs: ['001'], rxcui: ['IN_A'] };
        expect(deepMergeDrugLabel(null, cur)).toEqual(cur);
        expect(deepMergeDrugLabel(undefined, cur)).toEqual(cur);
    });

    it('6. retired record (cur null) returns prev as-is', () => {
        const prev = { id: 'OLD', ndcs: ['001'] };
        expect(deepMergeDrugLabel(prev, null)).toEqual(prev);
    });

    it('7. ANTI-REGRESSION: prev without ndcs (bootstrap state) does not synthesize empty array on cur-missing', () => {
        // If prev was emitted pre-PR-RXN-1b-pre (no ndcs field), and cur is
        // also missing ndcs, the merge should NOT inject an empty ndcs[] --
        // the field stays absent. This avoids polluting bootstrap records
        // with stub arrays that downstream consumers might misinterpret as
        // "intentionally empty".
        const prev = { id: 'X', title: 'A' };
        const cur = { id: 'X', title: 'B' };
        const merged = deepMergeDrugLabel(prev, cur);
        expect(merged.ndcs).toBeUndefined();
        expect(merged.rxcui).toBeUndefined();
        expect(merged.title).toBe('B');
    });

    it('8b. ANTI-REGRESSION: drug-labels.jsonl must be in MERGE_FILES (else strategy is deadcode)', () => {
        // PR-CORE-DRUG-LABEL-LEAK followup: deepMergeDrugLabel registration alone
        // is insufficient -- the file must also be in MERGE_FILES so that
        // mergeLocalAggregatedWithPrevious actually iterates it.
        expect(MERGE_FILES).toContain('drug-labels.jsonl');
        expect(MERGE_STRATEGY_PER_FILE['drug-labels.jsonl']).toBe(deepMergeDrugLabel);
    });

    it('8. ANTI-REGRESSION: mergeRecords full integration with deepMergeDrugLabel strategy preserves prev fields', () => {
        // End-to-end through the merger surface. Stage-3 production path.
        const prevRecords = [{
            id: 'sciweon::drug_label::SETID_1',
            title: 'Aspirin v1',
            ndcs: ['00042022001'],
            rxcui: ['83367'],
        }];
        const curRecords = [{
            id: 'sciweon::drug_label::SETID_1',
            title: 'Aspirin v2',
            // unhydrated F2 cur shape
        }];
        const { merged, stats } = mergeRecords(curRecords, prevRecords, r => r.id, deepMergeDrugLabel);
        expect(stats.replaced_by_current).toBe(1);
        expect(merged).toHaveLength(1);
        expect(merged[0].title).toBe('Aspirin v2');
        expect(merged[0].ndcs).toEqual(['00042022001']);
        expect(merged[0].rxcui).toEqual(['83367']);
    });
});
