// @ts-nocheck
/**
 * PR-OPS-1 Source Health Monitor dual-path hydration tests.
 *
 * Locks the semantic boundary between creator lineage
 * (entity.provenance.sources[]) and enricher fingerprint
 * (entity.external_ids.sources[]). Future drift back to single-path
 * scanning would silently lose 6+ enricher sources from the report.
 */

import { describe, it, expect } from 'vitest';
import {
    collectEntityStats, statusFor, KNOWN_SOURCES,
} from '../../scripts/factory/source-health-monitor.js';

describe('PR-OPS-1: dual-path collectEntityStats', () => {
    it('1. creator-only entity: provenance.sources[] populates stats with per-source timestamp', () => {
        const stats = {};
        collectEntityStats({
            provenance: {
                sources: [{ source: 'pubchem', timestamp: '2026-05-29T00:00:00Z' }],
                last_updated: '2026-05-29T00:00:00Z',
            },
            external_ids: {},
        }, stats);
        expect(stats.pubchem).toEqual({ records: 1, last_seen: '2026-05-29T00:00:00Z' });
    });

    it('2. enricher-only entity: external_ids.sources[] uses provenance.last_updated fallback', () => {
        const stats = {};
        collectEntityStats({
            provenance: { last_updated: '2026-05-29T00:00:00Z' },
            external_ids: { sources: ['rxnorm'] },
        }, stats);
        expect(stats.rxnorm).toEqual({ records: 1, last_seen: '2026-05-29T00:00:00Z' });
    });

    it('3. mixed entity: creator + 2 enrichers -> 3 distinct sources each with records=1', () => {
        const stats = {};
        collectEntityStats({
            provenance: {
                sources: [{ source: 'pubchem', timestamp: '2026-05-29T00:00:00Z' }],
                last_updated: '2026-05-29T01:00:00Z',
            },
            external_ids: { sources: ['unichem', 'rxnorm'] },
        }, stats);
        expect(stats.pubchem.records).toBe(1);
        expect(stats.unichem.records).toBe(1);
        expect(stats.rxnorm.records).toBe(1);
        expect(stats.pubchem.last_seen).toBe('2026-05-29T00:00:00Z');
        expect(stats.unichem.last_seen).toBe('2026-05-29T01:00:00Z');
        expect(stats.rxnorm.last_seen).toBe('2026-05-29T01:00:00Z');
    });

    it('4. DEDUP INVARIANT: same source in both paths -> records=1 (NOT 2), last_seen=max', () => {
        const stats = {};
        collectEntityStats({
            provenance: {
                sources: [{ source: 'pubchem', timestamp: '2026-05-29T00:00:00Z' }],
                last_updated: '2026-05-29T03:00:00Z',
            },
            external_ids: { sources: ['pubchem'] },
        }, stats);
        expect(stats.pubchem.records).toBe(1);
        expect(stats.pubchem.last_seen).toBe('2026-05-29T03:00:00Z');
    });

    it('5. enricher fingerprint with no derivable timestamp: records=1, last_seen=null', () => {
        const stats = {};
        collectEntityStats({
            external_ids: { sources: ['unichem'] },
        }, stats);
        expect(stats.unichem.records).toBe(1);
        expect(stats.unichem.last_seen).toBeNull();
    });

    it('6. defensive: null entity / missing arrays / non-string ids -> no-op no-throw', () => {
        const stats = {};
        expect(() => collectEntityStats(null, stats)).not.toThrow();
        expect(() => collectEntityStats({}, stats)).not.toThrow();
        expect(() => collectEntityStats({ external_ids: { sources: [null, undefined, 123, ''] } }, stats)).not.toThrow();
        expect(Object.keys(stats)).toHaveLength(0);
    });

    it('7. multiple entities aggregate across calls (records cumulative)', () => {
        const stats = {};
        for (let i = 0; i < 5; i++) {
            collectEntityStats({
                provenance: { sources: [{ source: 'pubchem', timestamp: '2026-05-29T00:00:00Z' }] },
                external_ids: { sources: ['rxnorm'] },
            }, stats);
        }
        expect(stats.pubchem.records).toBe(5);
        expect(stats.rxnorm.records).toBe(5);
    });
});

describe('PR-OPS-1: statusFor refinement (records-aware)', () => {
    it('records=0 -> MISSING (true absence)', () => {
        expect(statusFor(null, 0)).toBe('MISSING');
        expect(statusFor(12, 0)).toBe('MISSING');
    });

    it('records>0 + null timestamp -> HEALTHY (was MISSING pre-PR-OPS-1)', () => {
        expect(statusFor(null, 1)).toBe('HEALTHY');
        expect(statusFor(null, 999)).toBe('HEALTHY');
    });

    it('records>0 + 12h -> HEALTHY (within 36h band)', () => {
        expect(statusFor(12, 1)).toBe('HEALTHY');
    });

    it('records>0 + 50h -> STALE (36-96h band)', () => {
        expect(statusFor(50, 1)).toBe('STALE');
    });

    it('records>0 + 200h -> CRITICAL (>96h)', () => {
        expect(statusFor(200, 1)).toBe('CRITICAL');
    });
});

describe('PR-OPS-1: KNOWN_SOURCES canonicalization', () => {
    it('list is trimmed to 13 (was 15); semantic_scholar + pubmed removed', () => {
        expect(KNOWN_SOURCES).toHaveLength(13);
        expect(KNOWN_SOURCES).not.toContain('semantic_scholar');
        expect(KNOWN_SOURCES).not.toContain('pubmed');
        expect(KNOWN_SOURCES).toContain('s2');
        expect(KNOWN_SOURCES).toContain('openalex');
        expect(KNOWN_SOURCES).toContain('rxnorm');
    });
});
