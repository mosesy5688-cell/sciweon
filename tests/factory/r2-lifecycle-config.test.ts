/**
 * Tests for V0.5.8 Wave I-3 — R2 lifecycle TTL config builder.
 *
 * Pure tests verify the exact LifecycleConfiguration object that
 * PutBucketLifecycleConfigurationCommand will receive. R2 itself enforces
 * TTL server-side once applied; the only thing this code controls is the
 * shape of the rules array.
 *
 * Hardening (founder 2026-06-04, "preserve all source data; we are AI
 * infrastructure"): processed/bulk/ (the bulk SOURCE artifacts) is now an
 * EXPLICIT preserved prefix, and a guard test asserts no expiry rule can
 * ever be an ancestor-of / equal-to a preserved prefix (which would catch a
 * future broad rule — e.g. a `processed/` catch-all — sweeping the base data).
 */

import { describe, it, expect } from 'vitest';
import {
    LIFECYCLE_RULES,
    PRESERVED_PREFIXES,
    buildLifecycleConfig,
} from '../../scripts/factory/lib/r2-lifecycle-config.js';

describe('LIFECYCLE_RULES', () => {
    it('has 5 entries (raw + 3 processed + staging)', () => {
        expect(LIFECYCLE_RULES).toHaveLength(5);
    });

    it('each entry has id, prefix, days properties', () => {
        for (const r of LIFECYCLE_RULES) {
            expect(typeof r.id).toBe('string');
            expect(typeof r.prefix).toBe('string');
            expect(typeof r.days).toBe('number');
            expect(r.days).toBeGreaterThan(0);
        }
    });

    it('uses the documented prefixes (no typos)', () => {
        const prefixes = LIFECYCLE_RULES.map(r => r.prefix);
        expect(prefixes).toEqual(expect.arrayContaining([
            'raw/',
            'processed/baseline/',
            'processed/enriched/',
            'processed/aggregated/',
            'staging/incremental/',
        ]));
    });

    it('has the expected rule ids + TTL days (founder 90d for aggregated/baseline)', () => {
        const byId = new Map(LIFECYCLE_RULES.map(r => [r.id, r.days]));
        expect(byId.get('expire-aggregated-90d')).toBe(90);
        expect(byId.get('expire-baseline-90d')).toBe(90);
        expect(byId.get('expire-enriched-30d')).toBe(30);
        expect(byId.get('expire-raw-14d')).toBe(14);
        expect(byId.get('expire-staging-incremental-7d')).toBe(7);
    });

    it('preserved prefixes (bulk + cache + snapshots) are NOT in any rule (invariant)', () => {
        const prefixes = LIFECYCLE_RULES.map(r => r.prefix);
        for (const preserved of PRESERVED_PREFIXES) {
            expect(prefixes).not.toContain(preserved);
        }
    });

    it('processed/aggregated/ uses 90-day TTL (latest.json safe via daily rewrite)', () => {
        const rule = LIFECYCLE_RULES.find(r => r.prefix === 'processed/aggregated/');
        expect(rule?.days).toBe(90);
    });

    it('processed/baseline/ uses 90-day TTL (founder choice, matches live bucket)', () => {
        const rule = LIFECYCLE_RULES.find(r => r.prefix === 'processed/baseline/');
        expect(rule?.days).toBe(90);
    });

    it('processed/enriched/ uses 30-day TTL (unchanged)', () => {
        const rule = LIFECYCLE_RULES.find(r => r.prefix === 'processed/enriched/');
        expect(rule?.days).toBe(30);
    });

    it('raw/ uses 14-day TTL (shortest among intermediates per plan)', () => {
        const rule = LIFECYCLE_RULES.find(r => r.prefix === 'raw/');
        expect(rule?.days).toBe(14);
    });

    it('staging/incremental/ uses 7-day TTL (defense-in-depth; fan-in cleanup already runs)', () => {
        const rule = LIFECYCLE_RULES.find(r => r.prefix === 'staging/incremental/');
        expect(rule?.days).toBe(7);
    });
});

describe('PRESERVED_PREFIXES (preserve-all base data)', () => {
    it('explicitly preserves processed/bulk/, processed/cache/, snapshots/', () => {
        expect(PRESERVED_PREFIXES).toEqual(expect.arrayContaining([
            'processed/bulk/',
            'processed/cache/',
            'snapshots/',
        ]));
    });

    it('includes processed/bulk/ — the bulk SOURCE artifacts, preserve-all base data', () => {
        // Was preserved only by OMISSION (no rule); now explicit so a future
        // broad rule cannot silently sweep the UniProt/UMLS/RxNorm/OpenTargets base.
        expect(PRESERVED_PREFIXES).toContain('processed/bulk/');
    });
});

describe('preservation GUARD (no expiry rule may cover a preserved prefix)', () => {
    it('no lifecycle rule covers a preserved prefix (neither ancestor/equal NOR nested-under)', () => {
        // The preserve-all invariant is BIDIRECTIONAL: for every preserved
        // prefix P and every rule R, R must not cover ANY object under P. Two
        // directions can cause coverage:
        //   (1) ancestor-of / equal-to: P === R.prefix || P.startsWith(R.prefix)
        //       — a future `processed/` catch-all rule sweeps all of
        //         processed/bulk/ (R.prefix is an ancestor of P).
        //   (2) nested-under: R.prefix.startsWith(P) — a future narrow rule
        //       like `processed/bulk/uniprot/old/` would EXPIRE part of the
        //       preserved processed/bulk/ tree (R.prefix is nested under P).
        // The original guard only checked (1); (2) was a hole — a nested rule
        // passed it yet still violated preserve-all. Both are now flagged.
        for (const preserved of PRESERVED_PREFIXES) {
            for (const rule of LIFECYCLE_RULES) {
                const covers = preserved === rule.prefix          // equal
                            || preserved.startsWith(rule.prefix)  // rule is an ancestor of / equal to preserved
                            || rule.prefix.startsWith(preserved); // rule is nested UNDER preserved (NEW)
                expect(
                    covers,
                    `rule '${rule.id}' (prefix '${rule.prefix}') would expire preserved prefix '${preserved}'`,
                ).toBe(false);
            }
        }
    });

    it('guard rejects a rule nested under a preserved prefix (regression)', () => {
        // Proves direction (2) is caught WITHOUT mutating the exported arrays:
        // run the same bidirectional predicate over a synthetic bad ruleset.
        // A would-be `processed/bulk/uniprot/old/` 30-day rule is nested under
        // the preserved processed/bulk/ tree and must be detected as coverage.
        const preserved = 'processed/bulk/';
        const badRule = { id: 'expire-bulk-uniprot-old', prefix: 'processed/bulk/uniprot/old/', days: 30 };
        const covers = preserved === badRule.prefix
                    || preserved.startsWith(badRule.prefix)
                    || badRule.prefix.startsWith(preserved);
        expect(covers).toBe(true); // would-be preserve-all violation is detected
    });

    it('no two rule prefixes overlap (the "non-overlapping prefixes" doc invariant)', () => {
        for (const a of LIFECYCLE_RULES) {
            for (const b of LIFECYCLE_RULES) {
                if (a.id === b.id) continue;
                const overlaps = a.prefix.startsWith(b.prefix);
                expect(
                    overlaps,
                    `rule '${a.id}' (prefix '${a.prefix}') overlaps rule '${b.id}' (prefix '${b.prefix}')`,
                ).toBe(false);
            }
        }
    });
});

describe('buildLifecycleConfig', () => {
    it('produces a Rules array matching LIFECYCLE_RULES length', () => {
        const cfg = buildLifecycleConfig();
        expect(cfg.Rules).toHaveLength(LIFECYCLE_RULES.length);
    });

    it('every rule has Status: Enabled', () => {
        const cfg = buildLifecycleConfig();
        for (const r of cfg.Rules) expect(r.Status).toBe('Enabled');
    });

    it('every rule has Filter.Prefix matching LIFECYCLE_RULES.prefix', () => {
        const cfg = buildLifecycleConfig();
        for (const r of cfg.Rules) {
            const src = LIFECYCLE_RULES.find(s => s.id === r.ID);
            expect(src).toBeDefined();
            expect(r.Filter.Prefix).toBe(src?.prefix);
        }
    });

    it('every rule has Expiration.Days matching LIFECYCLE_RULES.days', () => {
        const cfg = buildLifecycleConfig();
        for (const r of cfg.Rules) {
            const src = LIFECYCLE_RULES.find(s => s.id === r.ID);
            expect(r.Expiration.Days).toBe(src?.days);
        }
    });

    it('maps each rule id to the right ID/Status/Prefix/Days', () => {
        const cfg = buildLifecycleConfig();
        for (const src of LIFECYCLE_RULES) {
            const out = cfg.Rules.find(r => r.ID === src.id);
            expect(out, `missing output rule for ${src.id}`).toBeDefined();
            expect(out?.Status).toBe('Enabled');
            expect(out?.Filter.Prefix).toBe(src.prefix);
            expect(out?.Expiration.Days).toBe(src.days);
        }
    });

    it('every rule has a unique ID', () => {
        const cfg = buildLifecycleConfig();
        const ids = cfg.Rules.map(r => r.ID);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('produces an object directly accepted by PutBucketLifecycleConfigurationCommand shape', () => {
        // Shape check: { Rules: [{ ID, Status, Filter:{Prefix}, Expiration:{Days} }] }
        const cfg = buildLifecycleConfig();
        for (const r of cfg.Rules) {
            expect(r).toHaveProperty('ID');
            expect(r).toHaveProperty('Status');
            expect(r).toHaveProperty('Filter');
            expect(r.Filter).toHaveProperty('Prefix');
            expect(r).toHaveProperty('Expiration');
            expect(r.Expiration).toHaveProperty('Days');
        }
    });
});
