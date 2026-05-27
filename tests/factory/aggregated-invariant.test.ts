// @ts-nocheck
/**
 * Tests for PR-CORE-MERGE-LEAK pre-upload invariant guard
 * (scripts/factory/lib/aggregated-invariant.js).
 *
 * Pure-function path covers countFullyEnrichedUnichem. The R2-touching path
 * (enforceCompletenessInvariant full call) is exercised end-to-end by F3
 * production dispatch; mocking the AWS SDK here would duplicate that
 * surface without adding signal. We focus on the predicate logic + the
 * bootstrap-safe behavior contract.
 */

import { describe, it, expect } from 'vitest';
import { countFullyEnrichedUnii, countFullyEnrichedUnichem } from '../../scripts/factory/lib/aggregated-invariant.js';

describe('countFullyEnrichedUnii (PR-FDA-SRS-3 universal UNII guard)', () => {
    it('counts records with external_ids.unii non-null regardless of source', () => {
        const records = [
            { external_ids: { unii: 'A', sources: ['unichem'] } },        // counted
            { external_ids: { unii: 'B', sources: ['unichem', 'fda_srs'] } }, // counted
            { external_ids: { unii: 'C', sources: ['fda_srs'] } },         // counted (source-agnostic)
            { external_ids: { unii: 'D' } },                               // counted (no sources requirement)
            { external_ids: { unii: null, sources: ['unichem'] } },        // not counted (no unii)
            { external_ids: { sources: ['unichem'] } },                    // not counted (no unii)
            { external_ids: { unii: '', sources: ['unichem'] } },          // not counted (empty-string unii)
            {},                                                            // not counted (empty)
            { external_ids: null },                                        // not counted (null)
        ];
        expect(countFullyEnrichedUnii(records)).toBe(4);
    });

    it('empty array returns 0', () => {
        expect(countFullyEnrichedUnii([])).toBe(0);
    });

    it('handles null/undefined records defensively', () => {
        expect(countFullyEnrichedUnii([null, undefined, { external_ids: { unii: 'X' } }])).toBe(1);
    });

    it('counts records with unii regardless of which source provided it (Option E decoupling)', () => {
        // Post-PR-FDA-SRS-3 semantic shift: invariant is source-agnostic.
        // Records with unii from fda_srs alone (no unichem source) count too.
        const records = [
            { external_ids: { unii: 'X', sources: ['fda_srs'] } },         // counted
            { external_ids: { unii: 'Y', sources: ['unichem'] } },         // counted
            { external_ids: { unii: 'Z', sources: ['unichem', 'fda_srs'] } }, // counted
        ];
        expect(countFullyEnrichedUnii(records)).toBe(3);
    });
});

describe('countFullyEnrichedUnichem (backward-compat alias of countFullyEnrichedUnii)', () => {
    it('exists as alias for legacy callers', () => {
        expect(typeof countFullyEnrichedUnichem).toBe('function');
        // Same behavior as countFullyEnrichedUnii post-PR-FDA-SRS-3
        const records = [{ external_ids: { unii: 'A' } }, { external_ids: { unii: null } }];
        expect(countFullyEnrichedUnichem(records)).toBe(countFullyEnrichedUnii(records));
    });
});

describe('Invariant guard contract (documented for ops)', () => {
    it('exports both new universal predicate + back-compat alias', () => {
        expect(typeof countFullyEnrichedUnii).toBe('function');
        expect(typeof countFullyEnrichedUnichem).toBe('function');
    });
});
