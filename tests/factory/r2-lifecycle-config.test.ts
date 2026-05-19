/**
 * Tests for V0.5.8 Wave I-3 — R2 lifecycle TTL config builder.
 *
 * Pure tests verify the exact LifecycleConfiguration object that
 * PutBucketLifecycleConfigurationCommand will receive. R2 itself enforces
 * TTL server-side once applied; the only thing this code controls is the
 * shape of the rules array.
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

    it('preserved prefixes (cache + snapshots) are NOT in any rule (invariant)', () => {
        const prefixes = LIFECYCLE_RULES.map(r => r.prefix);
        for (const preserved of PRESERVED_PREFIXES) {
            expect(prefixes).not.toContain(preserved);
        }
    });

    it('processed/aggregated/ uses 30-day TTL (latest.json safe via daily rewrite)', () => {
        const rule = LIFECYCLE_RULES.find(r => r.prefix === 'processed/aggregated/');
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
