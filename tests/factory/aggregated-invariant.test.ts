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
import { countFullyEnrichedUnichem } from '../../scripts/factory/lib/aggregated-invariant.js';

describe('countFullyEnrichedUnichem (matches source-required-fields.unichem predicate)', () => {
    it('counts records with both external_ids.unii AND sources contains "unichem"', () => {
        const records = [
            { external_ids: { unii: 'A', sources: ['unichem'] } },        // counted
            { external_ids: { unii: 'B', sources: ['unichem', 'faers'] } }, // counted
            { external_ids: { unii: 'C', sources: ['rxnorm'] } },          // no unichem
            { external_ids: { unii: null, sources: ['unichem'] } },        // no unii
            { external_ids: { sources: ['unichem'] } },                    // missing unii field
            { external_ids: { unii: 'D' } },                               // no sources array
            { external_ids: { unii: '', sources: ['unichem'] } },          // empty-string unii
            {},                                                            // empty record
            { external_ids: null },                                        // null external_ids
        ];
        expect(countFullyEnrichedUnichem(records)).toBe(2);
    });

    it('empty array returns 0', () => {
        expect(countFullyEnrichedUnichem([])).toBe(0);
    });

    it('handles null/undefined records defensively', () => {
        expect(countFullyEnrichedUnichem([null, undefined, { external_ids: { unii: 'X', sources: ['unichem'] } }])).toBe(1);
    });

    it('does NOT count records where unichem appears only in provenance.sources (not external_ids.sources)', () => {
        // The validator's external_ids.sources~~"unichem" is strict: it does
        // NOT look at provenance.sources. Mirror that here.
        const records = [
            { external_ids: { unii: 'X' }, provenance: { sources: ['unichem'] } },  // not counted
            { external_ids: { unii: 'X', sources: ['unichem'] } },                  // counted
        ];
        expect(countFullyEnrichedUnichem(records)).toBe(1);
    });
});

describe('Invariant guard contract (documented for ops)', () => {
    it('exports the predicate so source-completeness.js and stage-3 stay in sync', () => {
        expect(typeof countFullyEnrichedUnichem).toBe('function');
    });
});
