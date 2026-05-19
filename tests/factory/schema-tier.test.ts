/**
 * Tests for V0.5.7 schema field tier classifier (Wave H2b-5).
 *
 * `gate()` in REJECT mode historically threw on ANY violation. The new
 * tier-aware gate partitions violations: primary-source failures still
 * throw, but Sciweon-derived fields (confidence, mentioned_*, stats,
 * is_negative_outcome) become warnings.
 *
 * `classifyViolations` is the pure decision surface. `gate()` integration
 * behavior is exercised inline by the validation-gate consumers.
 */

import { describe, it, expect } from 'vitest';
import {
    classifyViolations,
    DERIVED_PATH_PATTERNS,
} from '../../scripts/factory/lib/schema-tier.js';

describe('classifyViolations', () => {
    it('empty errors -> empty partitions', () => {
        const r = classifyViolations([]);
        expect(r.primary).toEqual([]);
        expect(r.derived).toEqual([]);
    });

    it('non-array input -> empty partitions (no crash)', () => {
        expect(classifyViolations(null)).toEqual({ primary: [], derived: [] });
        expect(classifyViolations(undefined)).toEqual({ primary: [], derived: [] });
    });

    it('single primary violation goes to primary', () => {
        const errors = [{ path: 'compound:sciweon::compound::1.inchi_key', error: 'pattern mismatch' }];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(1);
        expect(r.derived).toHaveLength(0);
    });

    it('single derived violation (confidence.overall) goes to derived', () => {
        const errors = [{ path: 'paper:Y.confidence.overall', error: '-1 < min 0' }];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(0);
        expect(r.derived).toHaveLength(1);
    });

    it('array-index path (mentioned_compounds[0].mention_confidence) is derived', () => {
        const errors = [{
            path: 'paper:X.mentioned_compounds[0].mention_confidence',
            error: 'expected finite number',
        }];
        const r = classifyViolations(errors);
        expect(r.derived).toHaveLength(1);
        expect(r.primary).toHaveLength(0);
    });

    it('mixed -> correct partition', () => {
        const errors = [
            { path: 'compound:X.inchi_key', error: 'pattern mismatch' },                  // primary
            { path: 'compound:X.confidence.bioactivity', error: 'expected finite number' }, // derived
            { path: 'compound:X.smiles_canonical', error: 'required field missing' },     // primary
            { path: 'compound:X.stats.paper_count', error: '< min 0' },                    // derived
        ];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(2);
        expect(r.derived).toHaveLength(2);
        expect(r.primary.map(e => e.path)).toEqual([
            'compound:X.inchi_key',
            'compound:X.smiles_canonical',
        ]);
    });

    it('is_negative_outcome on trial path is derived', () => {
        const errors = [{ path: 'trial:NCT123.is_negative_outcome', error: 'expected boolean' }];
        const r = classifyViolations(errors);
        expect(r.derived).toHaveLength(1);
    });

    it('cross_source_agreement subtree is derived', () => {
        const errors = [{
            path: 'compound:X.confidence.cross_source_agreement.structural_match',
            error: 'expected boolean',
        }];
        const r = classifyViolations(errors);
        expect(r.derived).toHaveLength(1);
    });

    it('custom derivedPatterns override default', () => {
        const errors = [{ path: 'compound:X.foo', error: 'whatever' }];
        const r = classifyViolations(errors, [/\.foo$/]);
        expect(r.derived).toHaveLength(1);
        expect(r.primary).toHaveLength(0);
    });

    it('DERIVED_PATH_PATTERNS is a non-empty array of RegExp', () => {
        expect(Array.isArray(DERIVED_PATH_PATTERNS)).toBe(true);
        expect(DERIVED_PATH_PATTERNS.length).toBeGreaterThan(0);
        for (const p of DERIVED_PATH_PATTERNS) expect(p).toBeInstanceOf(RegExp);
    });
});
