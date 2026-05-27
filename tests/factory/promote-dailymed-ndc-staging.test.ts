// @ts-nocheck
/**
 * PR-RXN-1b-pre-promote tests (2026-05-28).
 *
 * Three architect-mandated invariant assertions + idempotency + dry-run
 * guards. Pure functions tested without R2 mock; full flow requires
 * @aws-sdk/client-s3 mock and is exercised end-to-end by the GHA dispatch.
 */

import { describe, it, expect } from 'vitest';
import {
    enforceInvariants, isAlreadyPromoted,
    ParityMismatchException, SetIdAlignmentException, ChronologicalGuardException,
} from '../../scripts/factory/promote-dailymed-ndc-staging.js';

function makeDrugLabel(setid, ndcs = null) {
    const rec = { id: `sciweon::drug_label::setid::${setid}`, setid };
    if (ndcs !== null) rec.ndcs = ndcs;
    return rec;
}

function makeOtherRecord(idPrefix, idx) {
    return { id: `sciweon::${idPrefix}::${idx}`, foo: 'bar' };
}

describe('PR-RXN-1b-pre-promote: enforceInvariants', () => {
    it('1. GREEN: equal length + setids aligned + chronological OK', () => {
        const agg = [makeDrugLabel('A'), makeDrugLabel('B'), makeDrugLabel('C')];
        const staging = [makeDrugLabel('A', []), makeDrugLabel('B', ['001']), makeDrugLabel('C', [])];
        const stats = enforceInvariants({
            aggregatedRecords: agg, stagingRecords: staging,
            aggregatedRunId: '100', stagingSourceRunId: '100',
        });
        expect(stats.drugLabelCount).toBe(3);
        expect(stats.aggregatedSetidCount).toBe(3);
    });

    it('2. Parity mismatch -> ParityMismatchException (476 vs 477)', () => {
        const agg = Array.from({ length: 477 }, (_, i) => makeDrugLabel(`A${i}`));
        const staging = Array.from({ length: 476 }, (_, i) => makeDrugLabel(`A${i}`, []));
        expect(() => enforceInvariants({
            aggregatedRecords: agg, stagingRecords: staging,
            aggregatedRunId: '100', stagingSourceRunId: '100',
        })).toThrow(ParityMismatchException);
        try {
            enforceInvariants({ aggregatedRecords: agg, stagingRecords: staging, aggregatedRunId: '100', stagingSourceRunId: '100' });
        } catch (e) {
            expect(e.message).toMatch(/staging=476.*aggregated=477/);
        }
    });

    it('3. SetID alignment fail -> SetIdAlignmentException', () => {
        const agg = [makeDrugLabel('A'), makeDrugLabel('B')];
        const staging = [makeDrugLabel('A', []), makeDrugLabel('GHOST_NOT_IN_AGG', [])];
        expect(() => enforceInvariants({
            aggregatedRecords: agg, stagingRecords: staging,
            aggregatedRunId: '100', stagingSourceRunId: '100',
        })).toThrow(SetIdAlignmentException);
    });

    it('4. Chronological tampering: aggregated run_id > staging source run_id -> abort', () => {
        const agg = [makeDrugLabel('A')];
        const staging = [makeDrugLabel('A', [])];
        expect(() => enforceInvariants({
            aggregatedRecords: agg, stagingRecords: staging,
            aggregatedRunId: '999',         // newer than staging source
            stagingSourceRunId: '100',      // older
        })).toThrow(ChronologicalGuardException);
    });

    it('5. Chronological equal: same run_id passes (post-fresh-backfill case)', () => {
        const agg = [makeDrugLabel('A')];
        const staging = [makeDrugLabel('A', [])];
        const stats = enforceInvariants({
            aggregatedRecords: agg, stagingRecords: staging,
            aggregatedRunId: '500', stagingSourceRunId: '500',
        });
        expect(stats.drugLabelCount).toBe(1);
    });

    it('6. ANTI-REGRESSION: non-drug_label records (ATC class etc) participate in length parity but not in setid alignment', () => {
        const agg = [makeDrugLabel('A'), makeOtherRecord('atc_class', 'C01')];
        const staging = [makeDrugLabel('A', []), makeOtherRecord('atc_class', 'C01')];
        const stats = enforceInvariants({
            aggregatedRecords: agg, stagingRecords: staging,
            aggregatedRunId: '100', stagingSourceRunId: '100',
        });
        expect(stats.drugLabelCount).toBe(1);
        expect(stats.aggregatedSetidCount).toBe(1);
    });
});

describe('PR-RXN-1b-pre-promote: isAlreadyPromoted', () => {
    it('returns true when all drug_label records have non-empty ndcs[]', () => {
        const records = [
            makeDrugLabel('A', ['001', '002']),
            makeDrugLabel('B', ['003']),
            makeOtherRecord('atc_class', 'C01'),
        ];
        expect(isAlreadyPromoted(records)).toBe(true);
    });

    it('returns false when any drug_label lacks ndcs[]', () => {
        const records = [
            makeDrugLabel('A', ['001']),
            makeDrugLabel('B'),  // no ndcs field
        ];
        expect(isAlreadyPromoted(records)).toBe(false);
    });

    it('returns false when ndcs[] is empty array', () => {
        const records = [
            makeDrugLabel('A', ['001']),
            makeDrugLabel('B', []),
        ];
        expect(isAlreadyPromoted(records)).toBe(false);
    });

    it('returns false on empty record set (nothing to promote)', () => {
        expect(isAlreadyPromoted([])).toBe(false);
    });

    it('ANTI-REGRESSION: ignores non-drug_label records when computing promoted state', () => {
        // Only drug_labels need ndcs[]; ATC/disease records are passthrough.
        const records = [
            makeDrugLabel('A', ['001']),
            makeOtherRecord('atc_class', 'C01'),  // no ndcs, but not a drug_label
            makeOtherRecord('disease', 'XYZ'),
        ];
        expect(isAlreadyPromoted(records)).toBe(true);
    });
});
