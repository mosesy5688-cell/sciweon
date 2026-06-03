// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    SOURCE_DEFERRALS, isDeferralExpired, applyDeferrals,
} from '../../scripts/factory/lib/source-deferrals.js';
import { aggregateSeverity, severityTierForPct } from '../../scripts/factory/lib/source-completeness-helpers.js';

const TEST_DEFERRALS = Object.freeze({
    rxnorm: { expected_coverage_pct: 8.0, due_date: '2026-06-15', responsible_pr: 'X', note: 'n' },
    unichem: { expected_coverage_pct: 38.0, due_date: '2026-07-15', responsible_pr: 'Y', note: 'n' },
});

describe('SOURCE_DEFERRALS SSoT shape', () => {
    it('has 5 first-class entries (PR-OT-7 removes open_targets; passes on merit)', () => {
        expect(Object.keys(SOURCE_DEFERRALS).sort()).toEqual(
            ['fda_srs', 'openfda_faers', 'pubchem_bioassay', 'rxnorm', 'unichem']
        );
    });
    it('every entry has expected_coverage_pct + due_date + responsible_pr + note', () => {
        for (const d of Object.values(SOURCE_DEFERRALS)) {
            expect(typeof d.expected_coverage_pct).toBe('number');
            expect(typeof d.due_date).toBe('string');
            expect(d.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(typeof d.responsible_pr).toBe('string');
            expect(typeof d.note).toBe('string');
        }
    });
});

describe('Fix 1: isDeferralExpired -- 10-char truncation', () => {
    it('24-char ISO Z stamp on due_date EQ -> not expired (substring(0,10) align)', () => {
        const deferral = { due_date: '2026-06-15' };
        expect(isDeferralExpired(deferral, '2026-06-15T00:00:01.000Z')).toBe(false);
    });
    it('day after due_date -> expired', () => {
        expect(isDeferralExpired({ due_date: '2026-06-15' }, '2026-06-16T00:00:00.000Z')).toBe(true);
    });
    it('day before due_date -> not expired', () => {
        expect(isDeferralExpired({ due_date: '2026-06-15' }, '2026-06-14T23:59:59.999Z')).toBe(false);
    });
    it('non-string inputs return false defensively', () => {
        expect(isDeferralExpired(null, '2026-06-15')).toBe(false);
        expect(isDeferralExpired({ due_date: '2026-06-15' }, null)).toBe(false);
    });
});

describe('Fix 2: expired deferral invalidation', () => {
    it('expired -> expired_deferrals[]; L1 skipped; severity_tier untouched', () => {
        const raw = { rxnorm: { gate_adjusted_pct: 9.0, severity_tier: 3 } };
        const r = applyDeferrals(raw, TEST_DEFERRALS, '2026-07-01T00:00:00.000Z');
        expect(r.telemetry.expired_deferrals).toEqual(['rxnorm']);
        expect(r.telemetry.deferrals_applied).toEqual([]);
        expect(r.adjustedStats.rxnorm.severity_tier).toBe(3);
    });
});

describe('Fix 3: broken-floor = Tier 1 HARDFAIL (no fall-through)', () => {
    it('rxnorm 2.5% < 8.0% floor -> Tier 1 HARDFAIL with diagnostic', () => {
        const raw = { rxnorm: { gate_adjusted_pct: 2.5, severity_tier: 1 } };
        const r = applyDeferrals(raw, TEST_DEFERRALS, '2026-05-25T00:00:00.000Z');
        expect(r.adjustedStats.rxnorm.severity_tier).toBe(1);
        expect(r.telemetry.new_regressions[0]).toContain('rxnorm: broke_deferral_floor_below_8%_actual_2.5%');
        expect(r.telemetry.deferrals_applied).toEqual([]);
    });
    it('rxnorm just below floor (7.99%) still Tier 1', () => {
        const raw = { rxnorm: { gate_adjusted_pct: 7.99 } };
        const r = applyDeferrals(raw, TEST_DEFERRALS, '2026-05-25T00:00:00.000Z');
        expect(r.adjustedStats.rxnorm.severity_tier).toBe(1);
    });
});

describe('Fix 4: RAW state preservation (deep clone defense)', () => {
    it('input perSourceStats object NOT mutated', () => {
        const raw = { rxnorm: { gate_adjusted_pct: 9.0, severity_tier: 3 } };
        const snapshot = JSON.stringify(raw);
        applyDeferrals(raw, TEST_DEFERRALS, '2026-05-25T00:00:00.000Z');
        expect(JSON.stringify(raw)).toBe(snapshot);
    });
    it('adjustedStats and input independent objects (nested mutation does not leak)', () => {
        const raw = { rxnorm: { gate_adjusted_pct: 9.0, severity_tier: 3, nested: { x: 1 } } };
        const r = applyDeferrals(raw, TEST_DEFERRALS, '2026-05-25T00:00:00.000Z');
        r.adjustedStats.rxnorm.nested.x = 999;
        expect(raw.rxnorm.nested.x).toBe(1);
    });
});

describe('Happy path + non-deferred sources', () => {
    it('rxnorm 9.0% >= 8.0% floor -> Tier 0, in deferrals_applied[]', () => {
        const raw = { rxnorm: { gate_adjusted_pct: 9.0, severity_tier: 3 } };
        const r = applyDeferrals(raw, TEST_DEFERRALS, '2026-05-25T00:00:00.000Z');
        expect(r.adjustedStats.rxnorm.severity_tier).toBe(0);
        expect(r.telemetry.deferrals_applied).toEqual(['rxnorm']);
        expect(r.telemetry.new_regressions).toEqual([]);
    });
    it('non-deferred source untouched', () => {
        const raw = { pubchem: { gate_adjusted_pct: 100, severity_tier: 0 } };
        const r = applyDeferrals(raw, TEST_DEFERRALS, '2026-05-25T00:00:00.000Z');
        expect(r.adjustedStats.pubchem.severity_tier).toBe(0);
        expect(r.telemetry.deferrals_applied).toEqual([]);
    });
    it('production-state R2 probe values -> all 5 deferred pass tier 0', () => {
        const raw = {
            rxnorm:           { gate_adjusted_pct: 8.97 },
            unichem:          { gate_adjusted_pct: 40.16 },
            openfda_faers:    { gate_adjusted_pct: 3.04 },
            pubchem_bioassay: { gate_adjusted_pct: 5.45 },
        };
        const r = applyDeferrals(raw, SOURCE_DEFERRALS, '2026-05-25T00:00:00.000Z');
        expect(r.telemetry.deferrals_applied.sort()).toEqual(
            ['openfda_faers', 'pubchem_bioassay', 'rxnorm', 'unichem']
        );
        expect(r.telemetry.new_regressions).toEqual([]);
        expect(aggregateSeverity(r.adjustedStats)).toBe(0);
    });
});

describe('PR-OT-7: open_targets passes on merit, no deferral; thresholds = tripwire', () => {
    it('open_targets has NO deferral entry (removed PR-OT-7)', () => {
        expect(SOURCE_DEFERRALS).not.toHaveProperty('open_targets');
    });
    it('applyDeferrals leaves an open_targets stat untouched (no deferral path)', () => {
        const raw = { open_targets: { gate_adjusted_pct: 73.45, severity_tier: 7 } };
        const r = applyDeferrals(raw, SOURCE_DEFERRALS, '2026-05-25T00:00:00.000Z');
        // severity_tier is NOT overwritten by a deferral; stays as-is
        expect(r.adjustedStats.open_targets.severity_tier).toBe(7);
        expect(r.telemetry.deferrals_applied).toEqual([]);
        expect(r.telemetry.new_regressions).toEqual([]);
    });
    it('re-scoped baseline B=73.45% -> base severity_tier 0 (passes on merit via {10,20,35})', () => {
        // Same path source-completeness.js uses: severityTierForPct(pct, source)
        // with the open_targets per-source {hardfail:10,warn:20,info:35}.
        expect(severityTierForPct(73.45, 'open_targets')).toBe(0);
    });
    it('a real OT-ingest regression (5.0% < hardfail 10) -> tier 1 HARDFAIL tripwire still fires', () => {
        expect(severityTierForPct(5.0, 'open_targets')).toBe(1);
    });
    it('the OT hardfail boundary behaves as a tripwire', () => {
        expect(severityTierForPct(9.99, 'open_targets')).toBe(1);   // < hardfail=10 -> HARDFAIL tripwire
        expect(severityTierForPct(10.0, 'open_targets')).toBe(2);   // >= hardfail, < warn=20 -> WARN
    });
});

describe('Defensive guards', () => {
    it('throws on non-object perSourceStats', () => {
        expect(() => applyDeferrals(null, TEST_DEFERRALS, '2026-05-25')).toThrow();
    });
    it('throws on non-object sourceDeferralsMap', () => {
        expect(() => applyDeferrals({}, null, '2026-05-25')).toThrow();
    });
    it('empty deferrals map -> all sources untouched', () => {
        const raw = { rxnorm: { gate_adjusted_pct: 9.0, severity_tier: 3 } };
        const r = applyDeferrals(raw, {}, '2026-05-25T00:00:00.000Z');
        expect(r.adjustedStats.rxnorm.severity_tier).toBe(3);
        expect(r.telemetry.deferrals_applied).toEqual([]);
    });
});
