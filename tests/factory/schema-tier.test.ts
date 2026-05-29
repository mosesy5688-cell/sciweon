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
    SCOPE_VIOLATION_RULES,
} from '../../scripts/factory/lib/schema-tier.js';

describe('classifyViolations', () => {
    it('empty errors -> empty partitions', () => {
        const r = classifyViolations([]);
        expect(r.primary).toEqual([]);
        expect(r.derived).toEqual([]);
        expect(r.scope).toEqual([]);
    });

    it('non-array input -> empty partitions (no crash)', () => {
        expect(classifyViolations(null)).toEqual({ primary: [], derived: [], scope: [] });
        expect(classifyViolations(undefined)).toEqual({ primary: [], derived: [], scope: [] });
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

describe('classifyViolations -- scope tier (PR-HARVEST-SCOPE-TIER)', () => {
    it('molecular_weight > max routes to scope bucket with exclusion_reason', () => {
        const errors = [{
            path: 'CID:111615.molecular_weight.value',
            error: '18657 > max 10000',
        }];
        const r = classifyViolations(errors);
        expect(r.scope).toHaveLength(1);
        expect(r.primary).toHaveLength(0);
        expect(r.derived).toHaveLength(0);
        expect(r.scope[0].exclusion_reason).toBe('macromolecule_out_of_scope');
        expect(r.scope[0].path).toBe('CID:111615.molecular_weight.value');
    });

    it('molecular_weight required-missing stays primary (not scope)', () => {
        // Scope rule requires both path AND error pattern. A required-missing
        // error is a real data quality issue, not an out-of-scope macromolecule.
        const errors = [{
            path: 'CID:42.molecular_weight.value',
            error: 'required field missing',
        }];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(1);
        expect(r.scope).toHaveLength(0);
    });

    it('molecular_weight at exact max boundary does not trigger scope', () => {
        // No violation produced at the boundary; nothing reaches the classifier.
        // But if some other rule emitted a non-scope error on the path it stays primary.
        const errors = [{
            path: 'CID:42.molecular_weight.value',
            error: 'expected finite number',
        }];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(1);
        expect(r.scope).toHaveLength(0);
    });

    it('ANTI-REGRESSION: mixed primary + scope -- scope is captured separately', () => {
        const errors = [
            { path: 'CID:99.inchi_key', error: 'pattern mismatch' },
            { path: 'CID:99.molecular_weight.value', error: '15000 > max 10000' },
        ];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(1);
        expect(r.scope).toHaveLength(1);
        expect(r.primary[0].path).toBe('CID:99.inchi_key');
    });

    it('custom scopeRules override default for tests / future scope tiers', () => {
        const errors = [{ path: 'X.foo', error: '5 > max 1' }];
        const customRules = [{
            pathPattern: /\.foo$/,
            errorPattern: /> max/,
            exclusion_reason: 'custom_scope',
        }];
        const r = classifyViolations(errors, undefined, customRules);
        expect(r.scope).toHaveLength(1);
        expect(r.scope[0].exclusion_reason).toBe('custom_scope');
    });

    it('SCOPE_VIOLATION_RULES is a non-empty exported array', () => {
        expect(Array.isArray(SCOPE_VIOLATION_RULES)).toBe(true);
        expect(SCOPE_VIOLATION_RULES.length).toBeGreaterThan(0);
        for (const rule of SCOPE_VIOLATION_RULES) {
            expect(rule.pathPattern).toBeInstanceOf(RegExp);
            expect(rule.errorPattern).toBeInstanceOf(RegExp);
            expect(typeof rule.exclusion_reason).toBe('string');
        }
    });
});

describe('classifyViolations -- trial long-text scope tier (PR-TRIAL-ISOLATION)', () => {
    it('interventions[].name overflow routes to scope (oversized_intervention_name)', () => {
        const errors = [{ path: 'trial:2024-518115-19-02.interventions[0].name', error: 'length 4020 > maxLength 4000' }];
        const r = classifyViolations(errors);
        expect(r.scope).toHaveLength(1);
        expect(r.primary).toHaveLength(0);
        expect(r.scope[0].exclusion_reason).toBe('oversized_intervention_name');
    });

    it('status_reason overflow routes to scope (oversized_status_reason)', () => {
        const errors = [{ path: 'trial:NCT1.status_reason', error: 'length 9000 > maxLength 8000' }];
        const r = classifyViolations(errors);
        expect(r.scope).toHaveLength(1);
        expect(r.scope[0].exclusion_reason).toBe('oversized_status_reason');
    });

    it('interventions[].name required-missing stays primary (overflow-only is scope)', () => {
        const errors = [{ path: 'trial:X.interventions[0].name', error: 'required field missing' }];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(1);
        expect(r.scope).toHaveLength(0);
    });

    it('mixed oversized name (scope) + bad id (primary) -> partitioned, primary preserved', () => {
        const errors = [
            { path: 'trial:X.id', error: 'pattern mismatch' },
            { path: 'trial:X.interventions[2].name', error: 'length 5000 > maxLength 4000' },
        ];
        const r = classifyViolations(errors);
        expect(r.primary).toHaveLength(1);
        expect(r.scope).toHaveLength(1);
        expect(r.primary[0].path).toBe('trial:X.id');
    });
});
