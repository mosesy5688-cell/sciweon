/**
 * Tests for the AGGREGATED_FILES SSoT (hotfix post-PR-#97).
 *
 * Guards against the silent-drift pattern that dropped target-index.json
 * from F4 uploads in production: previously stage-3-aggregate.js and
 * stage-4-upload.js each carried their own copy of the list, and PR #96
 * only updated the stage-3 copy. This module is now imported by both
 * stages; these tests assert the list is frozen, non-empty, and contains
 * the two derived index files (the items most prone to drift).
 */

import { describe, it, expect } from 'vitest';
import { AGGREGATED_FILES, SNAPSHOT_FILES } from '../../scripts/factory/lib/aggregated-files.js';

describe('AGGREGATED_FILES SSoT', () => {
    it('is a non-empty frozen array of strings', () => {
        expect(Array.isArray(AGGREGATED_FILES)).toBe(true);
        expect(AGGREGATED_FILES.length).toBeGreaterThan(0);
        expect(Object.isFrozen(AGGREGATED_FILES)).toBe(true);
        for (const f of AGGREGATED_FILES) {
            expect(typeof f).toBe('string');
            expect(f.length).toBeGreaterThan(0);
        }
    });

    it('contains the two derived index files (regression guard)', () => {
        expect(AGGREGATED_FILES).toContain('sciweon-search-index.json');
        expect(AGGREGATED_FILES).toContain('target-index.json');
    });

    it('contains the core aggregated jsonl files', () => {
        for (const required of [
            'compounds-enriched.jsonl',
            'bioactivities.jsonl',
            'trials.jsonl',
            'papers.jsonl',
            'neg-evidence.jsonl',
        ]) {
            expect(AGGREGATED_FILES).toContain(required);
        }
    });
});

describe('SNAPSHOT_FILES SSoT', () => {
    it('is a frozen superset of AGGREGATED_FILES', () => {
        expect(Object.isFrozen(SNAPSHOT_FILES)).toBe(true);
        for (const f of AGGREGATED_FILES) {
            expect(SNAPSHOT_FILES).toContain(f);
        }
    });

    it('includes drug-labels.jsonl (DailyMed standalone harvest, not in aggregated bundle)', () => {
        expect(SNAPSHOT_FILES).toContain('drug-labels.jsonl');
        expect(AGGREGATED_FILES).not.toContain('drug-labels.jsonl');
    });

    it('includes target-index.json — regression guard for the post-#98 silent drop', () => {
        expect(SNAPSHOT_FILES).toContain('target-index.json');
    });
});
