/**
 * RK-16A1 — read-budget kernel: closed budget, refusal at caps (no scan-to-fill,
 * no auto-raise), LIST does 0 canonical reads, parsed-heap ceilings.
 */
import { describe, it, expect } from 'vitest';
import {
    ReadBudget, newReadBudget, ROUTE_PROFILES, ABSOLUTE_MAX_R2_SUBREQUESTS,
    PAGE_PARSED_HEAP_MAX_BYTES, FAMILY_REQUEST_HEAP_MAX_BYTES,
} from '../../../src/worker/lib/rk16/read-budget';

describe('RK-16A1 read-budget — closed-budget self-check', () => {
    it('every profile sub-caps sum <= total_max and total_max <= 16', () => {
        for (const p of Object.values(ROUTE_PROFILES)) {
            expect(p.control_max + p.posting_max + p.canonical_max).toBeLessThanOrEqual(p.total_max);
            expect(p.total_max).toBeLessThanOrEqual(ABSOLUTE_MAX_R2_SUBREQUESTS);
        }
        expect(ABSOLUTE_MAX_R2_SUBREQUESTS).toBe(16);
    });
});

describe('RK-16A1 read-budget — LIST route does 0 canonical reads', () => {
    it('chargeCanonical() ALWAYS returns false on LIST and total stops at 8', () => {
        const b = newReadBudget('LIST');
        expect(b.chargeCanonical()).toBe(false);
        expect(b.canonicalUsed).toBe(0);
        expect(b.exhausted).toBe(true);

        // total caps at 8 across control(4) + posting(4).
        const b2 = newReadBudget('LIST');
        for (let i = 0; i < 4; i++) expect(b2.chargeControl()).toBe(true);
        for (let i = 0; i < 4; i++) expect(b2.chargePosting()).toBe(true);
        expect(b2.totalUsed).toBe(8);
        expect(b2.chargeControl()).toBe(false); // total exhausted
        expect(b2.chargePosting()).toBe(false);
        expect(b2.exhausted).toBe(true);
    });
});

describe('RK-16A1 read-budget — refusal at limit (no scan-to-fill, no auto-raise)', () => {
    it('once a sub-cap is hit the next charge returns false and counter does not advance', () => {
        const b = new ReadBudget(ROUTE_PROFILES.LIST);
        for (let i = 0; i < 4; i++) expect(b.chargeControl()).toBe(true);
        expect(b.controlUsed).toBe(4);
        expect(b.chargeControl()).toBe(false); // sub-cap hit
        expect(b.controlUsed).toBe(4);         // NOT advanced past cap
        expect(b.exhausted).toBe(true);
    });

    it('once the total is hit the next charge returns false (caller returns cursor)', () => {
        const b = newReadBudget('POINT_DETAIL'); // total 5, control 4, canonical 1
        for (let i = 0; i < 4; i++) expect(b.chargeControl()).toBe(true);
        expect(b.chargeCanonical()).toBe(true);  // 5th
        expect(b.totalUsed).toBe(5);
        expect(b.chargeCanonical()).toBe(false); // total exhausted
        expect(b.canExceedSignaled()).toBe(true);
    });

    it('sparse-filter walk: many refused charges still leave the budget capped', () => {
        const b = newReadBudget('LIST');
        // simulate a sparse scan that keeps trying past the cap
        for (let i = 0; i < 4; i++) b.chargePosting();
        for (let i = 0; i < 100; i++) {
            expect(b.chargePosting()).toBe(false); // refused every time
        }
        expect(b.postingUsed).toBe(4);   // never exceeded posting_max
        expect(b.totalUsed).toBeLessThanOrEqual(ROUTE_PROFILES.LIST.total_max);
        expect(b.exhausted).toBe(true);
    });

    it('INTERNAL_BATCH allows up to 8 canonical + 4 control = total 12', () => {
        const b = newReadBudget('INTERNAL_BATCH');
        for (let i = 0; i < 4; i++) expect(b.chargeControl()).toBe(true);
        for (let i = 0; i < 8; i++) expect(b.chargeCanonical()).toBe(true);
        expect(b.totalUsed).toBe(12);
        expect(b.chargeCanonical()).toBe(false);
        expect(b.chargeControl()).toBe(false);
    });
});

describe('RK-16A1 read-budget — parsed-heap ceilings', () => {
    it('a single page over the per-page 4MiB ceiling is refused', () => {
        const b = newReadBudget('LIST');
        expect(b.addParsedHeap(PAGE_PARSED_HEAP_MAX_BYTES + 1)).toBe(false);
        expect(b.exhausted).toBe(true);
        expect(b.parsedHeapUsed).toBe(0);
    });

    it('cumulative heap over the per-family 32MiB ceiling is refused', () => {
        const b = newReadBudget('INTERNAL_BATCH');
        // 8 pages of 4MiB == 32MiB exactly (ok), the 9th would exceed.
        for (let i = 0; i < 8; i++) {
            expect(b.addParsedHeap(PAGE_PARSED_HEAP_MAX_BYTES)).toBe(true);
        }
        expect(b.parsedHeapUsed).toBe(FAMILY_REQUEST_HEAP_MAX_BYTES);
        expect(b.addParsedHeap(1)).toBe(false); // would exceed per-family ceiling
        expect(b.exhausted).toBe(true);
    });
});
