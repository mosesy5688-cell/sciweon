// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import {
    SNOMED_ENTITY_CLASS, SNOMED_CANON_VERSION, UNSTAMPABLE_REASON_MISSING_ANCHOR,
    classifySnomedConcepts, buildSnomedStampingEntries,
    applyStampsToSnomed, buildSnomedStampingSummary,
} from '../../scripts/factory/lib/sid-snomed-stamping.js';
import { generateSID_S, generateSID_C } from '../../scripts/factory/lib/sid-generator.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

// Frozen reference pins -- computed PR-UMLS-3 (entity_class=snomed_concept,
// canon=snomed.concept.v1.0). NUMERIC SCTIDs ONLY (no SNOMED strings in tests). SID-S is
// content-addressed on `SNOMEDCT_US:<CODE>` ONLY (Correction 1), NEVER the preferred string.
// Re-derive: sha256('sciweon:snomed_concept:snomed.concept.v1.0:SNOMEDCT_US:<CODE>').hex[:32].
const FROZEN_PINS = [
    { code: '73211009', payload: 'SNOMEDCT_US:73211009', sidS: 'a409595b11d0aabe31aecd559a84e04a' },
    { code: '38341003', payload: 'SNOMEDCT_US:38341003', sidS: 'b42be5e83138ee10246972aba4ec248d' },
    { code: '22298006', payload: 'SNOMEDCT_US:22298006', sidS: '9bf38a9717b0f8cb09f59abb378948b8' },
    { code: '195967001', payload: 'SNOMEDCT_US:195967001', sidS: '41b646fc894d0240ae2736c9f0a885eb' },
];

describe('Frozen reference SID-S pins (snomed_concept, code-anchored, numeric SCTIDs)', () => {
    for (const pin of FROZEN_PINS) {
        it(`${pin.code} -> ${pin.sidS}`, () => {
            expect(generateSID_S(SNOMED_ENTITY_CLASS, pin.payload, SNOMED_CANON_VERSION)).toBe(pin.sidS);
        });
    }
    it('SID-S is anchored on the CODE not any string (permanence)', () => {
        const a = generateSID_S(SNOMED_ENTITY_CLASS, 'SNOMEDCT_US:73211009', SNOMED_CANON_VERSION);
        const b = generateSID_S(SNOMED_ENTITY_CLASS, 'SNOMEDCT_US:73211009', SNOMED_CANON_VERSION);
        expect(a).toBe(b);
        expect(a).toBe('a409595b11d0aabe31aecd559a84e04a');
    });
    it('snomed_concept counter=1 SID-C pinned', () => {
        expect(generateSID_C(SNOMED_ENTITY_CLASS, 1)).toBe('6c73f8b801ffc7d25733836ead05408b');
    });
});

describe('Constants lock', () => {
    it('SNOMED_ENTITY_CLASS = snomed_concept', () => {
        expect(SNOMED_ENTITY_CLASS).toBe('snomed_concept');
    });
    it('SNOMED_CANON_VERSION = snomed.concept.v1.0', () => {
        expect(SNOMED_CANON_VERSION).toBe('snomed.concept.v1.0');
    });
});

describe('classifySnomedConcepts -- hard-fail invariant + crosswalk hit', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    function makeConcept(overrides = {}) {
        return {
            code: '73211009', cui: 'C0011849', sab: 'SNOMEDCT_US', tty: 'PT',
            preferred_str: 'syn-placeholder', synonyms: [],
            anchor_payload: 'SNOMEDCT_US:73211009',
            canonicalization_version: 'snomed.concept.v1.0',
            ...overrides,
        };
    }

    it('valid concept -> unstamped on empty crosswalk', () => {
        const r = classifySnomedConcepts([makeConcept()], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe('a409595b11d0aabe31aecd559a84e04a');
    });

    it('missing anchor_payload -> unstampable', () => {
        const r = classifySnomedConcepts([makeConcept({ anchor_payload: null })], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_ANCHOR);
    });
    it('missing canonicalization_version -> unstampable', () => {
        expect(classifySnomedConcepts([makeConcept({ canonicalization_version: '' })], emptyIndex).unstampable).toHaveLength(1);
    });
    it('missing code -> unstampable', () => {
        expect(classifySnomedConcepts([makeConcept({ code: undefined })], emptyIndex).unstampable).toHaveLength(1);
    });

    it('crosswalk hit -> alreadyStamped', () => {
        const seed = [{
            sid_s: 'a409595b11d0aabe31aecd559a84e04a', sid_c: 'c'.repeat(32),
            entity_class: 'snomed_concept', canonicalization_version: 'snomed.concept.v1.0',
            canonical_identity_payload: 'SNOMEDCT_US:73211009',
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-06-02T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(seed);
        const r = classifySnomedConcepts([makeConcept()], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe('c'.repeat(32));
    });
});

describe('buildSnomedStampingEntries -- frozen sid_c pin + crosswalk fields', () => {
    it('counter=1 entry produces locked sid_c + snomed_concept crosswalk fields', () => {
        const unstamped = [{
            concept: { code: '73211009' },
            sidS: 'a409595b11d0aabe31aecd559a84e04a',
            anchorPayload: 'SNOMEDCT_US:73211009',
            canonVersion: 'snomed.concept.v1.0',
        }];
        const entries = buildSnomedStampingEntries({
            unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: '2026-06-02T00:00:00Z',
        });
        expect(entries[0].sidC).toBe('6c73f8b801ffc7d25733836ead05408b');
        expect(entries[0].code).toBe('73211009');
        expect(entries[0].crosswalkEntry.entity_class).toBe('snomed_concept');
        expect(entries[0].crosswalkEntry.canonicalization_version).toBe('snomed.concept.v1.0');
        expect(entries[0].crosswalkEntry.canonical_identity_payload).toBe('SNOMEDCT_US:73211009');
        expect(entries[0].crosswalkEntry.counter_value).toBe(1);
    });
});

describe('applyStampsToSnomed -- keys on code + paranoia branch', () => {
    it('stamps by code', () => {
        const c = [{ code: '73211009' }];
        const m = new Map([['73211009', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToSnomed(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('a');
        expect(c[0].sid_c).toBe('b');
    });
    it('stampMap miss -> warn + skippedParanoiaCount++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ code: '73211009' }, { code: '999999999' }];
        const r = applyStampsToSnomed(c, new Map([['73211009', { sid_s: 'a', sid_c: 'b' }]]));
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('buildSnomedStampingSummary', () => {
    it('summary shape', () => {
        const s = buildSnomedStampingSummary({
            totalConcepts: 537716, alreadyStamped: 0, newlyStamped: 537716, unstampable: 0,
            reservationsIssued: 11, skippedParanoiaCount: 0,
            elapsedMs: 100, ledgerKeys: ['k1'], shardCount: 1,
        });
        expect(s.total_concepts).toBe(537716);
        expect(s.newly_stamped).toBe(537716);
        expect(s.shard_count).toBe(1);
    });
});
