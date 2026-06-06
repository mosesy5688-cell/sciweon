// @ts-nocheck
/**
 * Tests for lib/linker-coverage.js (PR-B coverage-ceiling).
 *
 * Pins the pure freshness/eligibility/stamp predicates + the coverage-invariant
 * LOUD-throw that fix the B2 O(50) ceiling. nowMs is passed explicitly so every
 * case is deterministic (no real-clock coupling).
 */

import { describe, it, expect } from 'vitest';
import {
    DEFAULT_TRIALS_FRESHNESS_DAYS, DEFAULT_PAPERS_FRESHNESS_DAYS,
    TRIALS_STAMP_FIELD, PAPERS_STAMP_FIELD,
    getQueriedAt, isFresh, isEligibleForQuery, stampQueriedAt, assertCoverageProgress,
} from '../../scripts/factory/lib/linker-coverage.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-05T00:00:00.000Z');

function compoundWithStamp(field: string, iso: string | null) {
    const c: any = { id: 'sciweon::compound::CID:1' };
    if (iso != null) c.linkage = { [field]: iso };
    return c;
}

describe('default windows + field names', () => {
    it('trials 30d, papers 45d (matched-convention note: introduced here, no prior windowed stamp existed)', () => {
        expect(DEFAULT_TRIALS_FRESHNESS_DAYS).toBe(30);
        expect(DEFAULT_PAPERS_FRESHNESS_DAYS).toBe(45);
    });
    it('stamp field names', () => {
        expect(TRIALS_STAMP_FIELD).toBe('trials_queried_at');
        expect(PAPERS_STAMP_FIELD).toBe('papers_queried_at');
    });
});

describe('getQueriedAt', () => {
    it('returns the stamp string when present', () => {
        const c = compoundWithStamp(TRIALS_STAMP_FIELD, '2026-05-01T00:00:00Z');
        expect(getQueriedAt(c, TRIALS_STAMP_FIELD)).toBe('2026-05-01T00:00:00Z');
    });
    it('returns null when linkage / field absent', () => {
        expect(getQueriedAt({ id: 'x' }, TRIALS_STAMP_FIELD)).toBe(null);
        expect(getQueriedAt(compoundWithStamp(PAPERS_STAMP_FIELD, '2026-05-01T00:00:00Z'), TRIALS_STAMP_FIELD)).toBe(null);
    });
    it('returns null for empty string', () => {
        expect(getQueriedAt(compoundWithStamp(TRIALS_STAMP_FIELD, ''), TRIALS_STAMP_FIELD)).toBe(null);
    });
});

describe('isFresh (windowed skip-if-stamped)', () => {
    it('missing stamp is NOT fresh -> eligible (never silently skipped)', () => {
        const c = compoundWithStamp(TRIALS_STAMP_FIELD, null);
        expect(isFresh(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(false);
        expect(isEligibleForQuery(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(true);
    });
    it('stamp INSIDE the window is fresh -> skipped', () => {
        const c = compoundWithStamp(TRIALS_STAMP_FIELD, new Date(NOW - 10 * DAY).toISOString());
        expect(isFresh(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(true);
        expect(isEligibleForQuery(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(false);
    });
    it('stamp OUTSIDE the window is stale -> eligible (cursor advances to it)', () => {
        const c = compoundWithStamp(TRIALS_STAMP_FIELD, new Date(NOW - 40 * DAY).toISOString());
        expect(isFresh(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(false);
        expect(isEligibleForQuery(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(true);
    });
    it('boundary: exactly at the window edge is stale (ageMs < window is strict)', () => {
        const c = compoundWithStamp(TRIALS_STAMP_FIELD, new Date(NOW - 30 * DAY).toISOString());
        expect(isFresh(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(false);
    });
    it('unparseable stamp -> treated as never-queried (eligible)', () => {
        const c = compoundWithStamp(TRIALS_STAMP_FIELD, 'not-a-date');
        expect(isFresh(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(false);
    });
    it('future stamp (clock skew) -> fresh (do not churn)', () => {
        const c = compoundWithStamp(TRIALS_STAMP_FIELD, new Date(NOW + 5 * DAY).toISOString());
        expect(isFresh(c, TRIALS_STAMP_FIELD, 30, NOW)).toBe(true);
    });
    it('papers use a wider default window (45d): a 40d stamp is still fresh for papers but stale for trials', () => {
        const cP = compoundWithStamp(PAPERS_STAMP_FIELD, new Date(NOW - 40 * DAY).toISOString());
        expect(isEligibleForQuery(cP, PAPERS_STAMP_FIELD, 45, NOW)).toBe(false);
        const cT = compoundWithStamp(TRIALS_STAMP_FIELD, new Date(NOW - 40 * DAY).toISOString());
        expect(isEligibleForQuery(cT, TRIALS_STAMP_FIELD, 30, NOW)).toBe(true);
    });
});

describe('stampQueriedAt', () => {
    it('creates linkage when absent + sets the field', () => {
        const c: any = { id: 'x' };
        stampQueriedAt(c, TRIALS_STAMP_FIELD, '2026-06-05T00:00:00Z');
        expect(c.linkage.trials_queried_at).toBe('2026-06-05T00:00:00Z');
    });
    it('preserves other linkage fields (additive)', () => {
        const c: any = { id: 'x', linkage: { papers_queried_at: '2026-04-01T00:00:00Z', other: 1 } };
        stampQueriedAt(c, TRIALS_STAMP_FIELD, '2026-06-05T00:00:00Z');
        expect(c.linkage.papers_queried_at).toBe('2026-04-01T00:00:00Z');
        expect(c.linkage.other).toBe(1);
        expect(c.linkage.trials_queried_at).toBe('2026-06-05T00:00:00Z');
    });
});

describe('assertCoverageProgress (PR-1: frozen-cursor THROW vs outage DEGRADE verdict)', () => {
    it('FROZEN CURSOR (queried==0, queryErrorCount==0) still THROWS (HALT, unchanged message)', () => {
        // No errors AND nothing queried -> a genuine drain/cursor bug -> LOUD halt (F3 exits 1).
        expect(() => assertCoverageProgress(1234, 0, 'TRIAL-LINKER')).toThrow(/HALT/);
        expect(() => assertCoverageProgress(1234, 0, 'TRIAL-LINKER')).toThrow(/eligible=1234 but queried=0/);
        expect(() => assertCoverageProgress(1234, 0, 'TRIAL-LINKER')).toThrow(/cursor is frozen/);
        // Explicit zero-error opts -> same throw.
        expect(() => assertCoverageProgress(1234, 0, 'TRIAL-LINKER', { queryErrorCount: 0, chunkAttempted: 1234 }))
            .toThrow(/HALT/);
    });
    it('OUTAGE (queried==0, chunkAttempted>0, queryErrorCount>0) returns {degrade:true} (no throw)', () => {
        // Some/all of the attempted chunk errored -> a 3rd-party outage, not our bug.
        expect(assertCoverageProgress(1234, 0, 'PAPER-LINKER', { queryErrorCount: 50, chunkAttempted: 50 }))
            .toEqual({ degrade: true });
        // queryErrorCount > 0 is the gate (NOT >= chunkAttempted): a partial-error chunk that still
        // reached queried==0 means the only outcomes were failures -> degrade.
        expect(assertCoverageProgress(1234, 0, 'PAPER-LINKER', { queryErrorCount: 1, chunkAttempted: 50 }))
            .toEqual({ degrade: true });
    });
    it('NORMAL (queried>0) returns {degrade:false} (no throw)', () => {
        expect(assertCoverageProgress(1234, 1, 'TRIAL-LINKER', { queryErrorCount: 0, chunkAttempted: 1234 }))
            .toEqual({ degrade: false });
        expect(assertCoverageProgress(1234, 1234, 'TRIAL-LINKER')).toEqual({ degrade: false });
        // queried>0 even WITH some errors is normal progress (the cursor advanced).
        expect(assertCoverageProgress(1234, 5, 'TRIAL-LINKER', { queryErrorCount: 10, chunkAttempted: 50 }))
            .toEqual({ degrade: false });
    });
    it('nothing eligible (all fresh) returns {degrade:false} (no throw)', () => {
        expect(assertCoverageProgress(0, 0, 'PAPER-LINKER')).toEqual({ degrade: false });
    });
});
