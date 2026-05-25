// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    DISEASE_ENTITY_CLASS, CANON_VERSIONS, PRIMARY_NAMESPACE_MAP, TAIL_FUSE_NAMESPACE,
    UNSTAMPABLE_REASON_MISSING_ANCHOR,
    classifyDiseases, buildDiseaseStampingEntries,
    applyStampsToDiseases, buildPerCanonVersionCounts, buildDiseaseStampingSummary,
} from '../../scripts/factory/lib/sid-disease-stamping.js';
import { generateSID_S, generateSID_C } from '../../scripts/factory/lib/sid-generator.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

// Frozen reference pins — execution-gate verified 2026-05-25 + production R2
// probe validated end-to-end via pre.1b open-derivability check.
const FROZEN_PINS = [
    { raw: 'EFO_0000094', canon: 'disease.efo.v1.0', payload: 'efo:0000094', sidS: 'bbe589ace6048150231646c7dfdc510b' },
    { raw: 'MONDO_0000005', canon: 'disease.mondo.v1.0', payload: 'mondo:0000005', sidS: 'ca10368a6f87a07e0bcd9c9c0ad1cd4b' },
    { raw: 'OBA_0000015', canon: 'disease.oba.v1.0', payload: 'oba:0000015', sidS: '97e43da8376555aaa21763667619097a' },
    { raw: 'HP_0000002', canon: 'disease.hp.v1.0', payload: 'hp:0000002', sidS: '56b568ff785d279acde583e08d0dfa56' },
    { raw: 'Orphanet_100', canon: 'disease.orphanet.v1.0', payload: 'orphanet:100', sidS: '88f2c9c94c3c04de40aa1800aba9db43' },
    { raw: 'DOID_0050890', canon: 'disease.unclassified_ontology.v1.0', payload: 'unclassified_ontology:DOID_0050890', sidS: '73c43a1559327b12fb7063d719104da0' },
];

describe('Frozen reference SID-S pins (production-validated 2026-05-25)', () => {
    for (const pin of FROZEN_PINS) {
        it(`${pin.raw} -> ${pin.sidS}`, () => {
            expect(generateSID_S(DISEASE_ENTITY_CLASS, pin.payload, pin.canon)).toBe(pin.sidS);
        });
    }
    it('disease counter=1 SID-C pinned', () => {
        expect(generateSID_C(DISEASE_ENTITY_CLASS, 1)).toBe('191fdb55e7de7549e573638ccb1dc813');
    });
});

describe('Constants lock', () => {
    it('DISEASE_ENTITY_CLASS = disease', () => {
        expect(DISEASE_ENTITY_CLASS).toBe('disease');
    });
    it('CANON_VERSIONS has 6 canon tracks (5 primary + 1 tail-fuse)', () => {
        expect(Object.keys(CANON_VERSIONS).sort()).toEqual(['efo', 'hp', 'mondo', 'oba', 'orphanet', 'unclassified_ontology']);
    });
    it('PRIMARY_NAMESPACE_MAP has 5 first-class entries', () => {
        expect(Object.keys(PRIMARY_NAMESPACE_MAP).length).toBe(5);
    });
    it('TAIL_FUSE_NAMESPACE = unclassified_ontology', () => {
        expect(TAIL_FUSE_NAMESPACE).toBe('unclassified_ontology');
    });
});

describe('classifyDiseases — hard-fail invariant + crosswalk hit', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    function makeDisease(overrides = {}) {
        return {
            id: 'sciweon::disease::efo:0000094',
            namespace: 'efo',
            anchor_payload: 'efo:0000094',
            canonicalization_version: 'disease.efo.v1.0',
            ...overrides,
        };
    }

    it('valid disease -> unstamped on empty crosswalk', () => {
        const r = classifyDiseases([makeDisease()], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe('bbe589ace6048150231646c7dfdc510b');
    });

    it('missing anchor_payload -> unstampable', () => {
        const r = classifyDiseases([makeDisease({ anchor_payload: null })], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_ANCHOR);
    });
    it('missing canonicalization_version -> unstampable', () => {
        expect(classifyDiseases([makeDisease({ canonicalization_version: '' })], emptyIndex).unstampable).toHaveLength(1);
    });
    it('missing namespace -> unstampable', () => {
        expect(classifyDiseases([makeDisease({ namespace: undefined })], emptyIndex).unstampable).toHaveLength(1);
    });

    it('crosswalk hit -> alreadyStamped', () => {
        const seed = [{
            sid_s: 'bbe589ace6048150231646c7dfdc510b', sid_c: 'c'.repeat(32),
            entity_class: 'disease', canonicalization_version: 'disease.efo.v1.0',
            canonical_identity_payload: 'efo:0000094',
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-05-25T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(seed);
        const r = classifyDiseases([makeDisease()], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe('c'.repeat(32));
    });

    it('mixed batch routes correctly across all 6 namespaces', () => {
        const all = FROZEN_PINS.map(p => makeDisease({
            id: `sciweon::disease::${p.payload}`,
            namespace: p.payload.split(':')[0],
            anchor_payload: p.payload,
            canonicalization_version: p.canon,
        }));
        const r = classifyDiseases(all, emptyIndex);
        expect(r.unstamped).toHaveLength(6);
        for (let i = 0; i < FROZEN_PINS.length; i++) {
            expect(r.unstamped[i].sidS).toBe(FROZEN_PINS[i].sidS);
        }
    });
});

describe('buildDiseaseStampingEntries — frozen sid_c pin', () => {
    it('counter=1 entry produces locked sid_c via generateSID_C', () => {
        const unstamped = [{
            disease: { id: 'sciweon::disease::efo:0000094' },
            sidS: 'bbe589ace6048150231646c7dfdc510b',
            anchorPayload: 'efo:0000094',
            canonVersion: 'disease.efo.v1.0',
        }];
        const entries = buildDiseaseStampingEntries({
            unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: '2026-05-25T00:00:00Z',
        });
        expect(entries[0].sidC).toBe('191fdb55e7de7549e573638ccb1dc813');
        expect(entries[0].crosswalkEntry.entity_class).toBe('disease');
        expect(entries[0].crosswalkEntry.canonicalization_version).toBe('disease.efo.v1.0');
        expect(entries[0].crosswalkEntry.canonical_identity_payload).toBe('efo:0000094');
        expect(entries[0].crosswalkEntry.counter_value).toBe(1);
    });
});

describe('applyStampsToDiseases — paranoia branch', () => {
    it('opaque disease.id stamping', () => {
        const d = [{ id: 'sciweon::disease::efo:0000094' }];
        const m = new Map([['sciweon::disease::efo:0000094', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToDiseases(d, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(d[0].sid_s).toBe('a');
    });
    it('stampMap miss -> warn + skippedParanoiaCount++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const d = [{ id: 'd1' }, { id: 'd2' }];
        const r = applyStampsToDiseases(d, new Map([['d1', { sid_s: 'a', sid_c: 'b' }]]));
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('buildPerCanonVersionCounts + buildDiseaseStampingSummary', () => {
    it('per-canon-version counts across all 6 namespaces', () => {
        const d = FROZEN_PINS.map(p => ({ namespace: p.payload.split(':')[0] }));
        const counts = buildPerCanonVersionCounts(d);
        expect(counts.efo).toBe(1);
        expect(counts.mondo).toBe(1);
        expect(counts.oba).toBe(1);
        expect(counts.hp).toBe(1);
        expect(counts.orphanet).toBe(1);
        expect(counts.unclassified_ontology).toBe(1);
    });
    it('summary shape includes per_canon_version_counts', () => {
        const s = buildDiseaseStampingSummary({
            totalDiseases: 47030, alreadyStamped: 0, newlyStamped: 47030, unstampable: 0,
            perCanonVersionCounts: { efo: 11928, mondo: 12785, oba: 17441, hp: 2315, orphanet: 2040, unclassified_ontology: 521 },
            reservationsIssued: 1, skippedParanoiaCount: 0,
            elapsedMs: 100, ledgerKeys: ['k1'], shardCount: 1,
        });
        expect(s.total_diseases).toBe(47030);
        expect(s.per_canon_version_counts.oba).toBe(17441);
        expect(s.shard_count).toBe(1);
    });
});
