/**
 * Tests for the AGGREGATED_FILES / ENRICHED_FILES / SNAPSHOT_FILES SSoT
 * (hotfix post-PR-#97, extended cycle 21 closure 2026-05-23).
 *
 * Guards against the silent-drift pattern that:
 *   - PR #96 dropped target-index.json from F4 (stage-3/4 list drift)
 *   - PR #98 fixed stage-3/4 drift with AGGREGATED_FILES SSoT
 *   - cycle 21 PRs #103-#8 emitted drug-labels.jsonl in stage-2 but
 *     stage-2-process.js hard-coded only 2 files in its upload call,
 *     silently dropping drug-labels.jsonl every cron for 11 days
 *   - 2026-05-23 hotfix added ENRICHED_FILES SSoT for stage-2 (same
 *     pattern, third boundary closed)
 *
 * Three SSoT lists for three stage boundaries:
 *   ENRICHED_FILES   stage-2 → R2 processed/enriched/
 *   AGGREGATED_FILES stage-3 → R2 processed/aggregated/ (superset)
 *   SNAPSHOT_FILES   snapshot-builder → snapshots/<date>/ (currently == AGGREGATED_FILES)
 */

import { describe, it, expect } from 'vitest';
import { ENRICHED_FILES, AGGREGATED_FILES, SNAPSHOT_FILES } from '../../scripts/factory/lib/aggregated-files.js';

describe('ENRICHED_FILES SSoT (stage-2 upload list)', () => {
    it('is a non-empty frozen array of strings', () => {
        expect(Array.isArray(ENRICHED_FILES)).toBe(true);
        expect(ENRICHED_FILES.length).toBeGreaterThan(0);
        expect(Object.isFrozen(ENRICHED_FILES)).toBe(true);
        for (const f of ENRICHED_FILES) {
            expect(typeof f).toBe('string');
            expect(f.length).toBeGreaterThan(0);
        }
    });

    it('includes drug-labels.jsonl — regression guard for cycle 21 PRs #103-#8 silent drop', () => {
        // PR #103 added adapter-cross-linker drug-labels.jsonl emit but
        // stage-2-process.js:153 hard-coded only 2 files. uploadStage's
        // missing check passed (file existed locally) but R2 never saw
        // it. 11 days of cron silently dropped drug-labels.jsonl until
        // user mid-session question 2026-05-23 surfaced the chain miss.
        // This guard prevents recurrence.
        expect(ENRICHED_FILES).toContain('drug-labels.jsonl');
    });

    it('includes the two stage-2 enricher outputs', () => {
        expect(ENRICHED_FILES).toContain('compounds-enriched.jsonl');
        expect(ENRICHED_FILES).toContain('bioactivities.jsonl');
    });
});

describe('AGGREGATED_FILES SSoT (stage-3 bundle)', () => {
    it('is a non-empty frozen array of strings', () => {
        expect(Array.isArray(AGGREGATED_FILES)).toBe(true);
        expect(AGGREGATED_FILES.length).toBeGreaterThan(0);
        expect(Object.isFrozen(AGGREGATED_FILES)).toBe(true);
        for (const f of AGGREGATED_FILES) {
            expect(typeof f).toBe('string');
            expect(f.length).toBeGreaterThan(0);
        }
    });

    it('is a superset of ENRICHED_FILES (stage-3 passes stage-2 outputs through)', () => {
        for (const f of ENRICHED_FILES) {
            expect(AGGREGATED_FILES).toContain(f);
        }
    });

    it('contains the two derived index files (regression guard PR #96/#98)', () => {
        expect(AGGREGATED_FILES).toContain('sciweon-search-index.json');
        expect(AGGREGATED_FILES).toContain('target-index.json');
    });

    it('contains the core aggregated jsonl files', () => {
        for (const required of [
            'compounds-enriched.jsonl',
            'bioactivities.jsonl',
            'drug-labels.jsonl',
            'trials.jsonl',
            'papers.jsonl',
            'neg-evidence.jsonl',
        ]) {
            expect(AGGREGATED_FILES).toContain(required);
        }
    });
});

describe('SNAPSHOT_FILES SSoT (snapshot-builder publish list)', () => {
    it('is a frozen superset of AGGREGATED_FILES', () => {
        expect(Object.isFrozen(SNAPSHOT_FILES)).toBe(true);
        for (const f of AGGREGATED_FILES) {
            expect(SNAPSHOT_FILES).toContain(f);
        }
    });

    it('includes drug-labels.jsonl (now via AGGREGATED_FILES, not separate)', () => {
        // Pre-2026-05-23: drug-labels was a separate entry added directly
        // to SNAPSHOT_FILES because it was harvested out-of-band by
        // dailymed-harvest.js and never flowed through stage-3.
        // Post-2026-05-23: adapter-cross-linker emits it in stage-2,
        // flows through ENRICHED_FILES → AGGREGATED_FILES → SNAPSHOT_FILES
        // unified pipeline. The presence in SNAPSHOT_FILES is now via
        // AGGREGATED_FILES inheritance, not direct addition.
        expect(SNAPSHOT_FILES).toContain('drug-labels.jsonl');
        expect(AGGREGATED_FILES).toContain('drug-labels.jsonl');
    });

    it('includes target-index.json — regression guard for the post-#98 silent drop', () => {
        expect(SNAPSHOT_FILES).toContain('target-index.json');
    });
});
