// @ts-nocheck
/**
 * PR-MD-1b: NDC SAB whitelist boundary (isAcceptedNdcSab).
 *
 * loadIngredientAttributes streams from a node-stream-zip handle (integration-
 * tested via live dispatch), so the admission decision was extracted to the pure
 * isAcceptedNdcSab predicate to make the whitelist a unit-testable SSoT.
 *
 * Verdict from probe run 26676173465: MTHSPL NDCs are 100% normalizable, so
 * MTHSPL is admitted alongside RXNORM. Commercial / other SABs stay excluded
 * (the purity guard) -- admitting the FDA-source MTHSPL must NOT open the gate
 * to varied-format commercial namespaces.
 */

import { describe, it, expect } from 'vitest';
import { isAcceptedNdcSab } from '../../scripts/factory/lib/rxnorm-rrf-streams.js';

describe('PR-MD-1b: isAcceptedNdcSab whitelist', () => {
    it('admits RXNORM (canonical HIPAA NDC source)', () => {
        expect(isAcceptedNdcSab('RXNORM')).toBe(true);
    });

    it('admits MTHSPL (FDA SPL, probe-confirmed 100% normalizable)', () => {
        expect(isAcceptedNdcSab('MTHSPL')).toBe(true);
    });

    it('PURITY GUARD: still excludes other SABs present in the NDC distribution', () => {
        // run 26668924180 NDC SAB distribution carried these; none admitted by 1b.
        for (const sab of ['VANDF', 'NDDF', 'MMX', 'GS', 'MMSL', 'CVX']) {
            expect(isAcceptedNdcSab(sab)).toBe(false);
        }
    });

    it('excludes empty / unknown / case-variant SAB (exact match only)', () => {
        expect(isAcceptedNdcSab('')).toBe(false);
        expect(isAcceptedNdcSab('mthspl')).toBe(false);  // SAB values are uppercase in RRF
        expect(isAcceptedNdcSab('UNKNOWN_SAB')).toBe(false);
        expect(isAcceptedNdcSab(undefined)).toBe(false);
    });
});
