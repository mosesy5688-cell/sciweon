// @ts-nocheck
/**
 * PR-UMLS-4: SID LOINC stamping pure-function contract tests (loinc_concept entity class).
 *
 * Locks the frozen reference SID-S pins (content-addressed on LNC:<CODE> ONLY, Correction 1),
 * the counter=1 SID-C pin, the hard-fail unstampable invariant, the crosswalk hit path, and
 * the code-keyed stamp-apply + paranoia branch. Mirrors sid-snomed-stamping.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    LOINC_ENTITY_CLASS, LOINC_CANON_VERSION, UNSTAMPABLE_REASON_MISSING_ANCHOR,
    classifyLoincConcepts, buildLoincStampingEntries,
    applyStampsToLoinc, buildLoincStampingSummary,
} from '../../scripts/factory/lib/sid-loinc-stamping.js';
import { generateSID_S, generateSID_C } from '../../scripts/factory/lib/sid-generator.js';
import { buildCrosswalkIndex } from '../../scripts/factory/lib/sid-crosswalk.js';

// Frozen reference pins -- computed PR-UMLS-4 with the REAL generateSID_S (entity_class=
// loinc_concept, canon=loinc.concept.v1.0). SID-S is content-addressed on `LNC:<CODE>` ONLY
// (Correction 1), NEVER the preferred string. The code strings here are SYNTHETIC.
// Re-derive: sha256('sciweon:loinc_concept:loinc.concept.v1.0:LNC:<CODE>').hex[:32].
const FROZEN_PINS = [
    { code: '34084-4', payload: 'LNC:34084-4', sidS: 'fcb5f8a230b0ae535b7dd7590dad9b22' },
    { code: '2951-2', payload: 'LNC:2951-2', sidS: '3c455697051356ac917c15020442f95b' },
    { code: '718-7', payload: 'LNC:718-7', sidS: '11c121ac0d216a075c50936e6b48d178' },
    { code: '2160-0', payload: 'LNC:2160-0', sidS: '32268687eee46ade41697c594fa92972' },
];

describe('Frozen reference SID-S pins (loinc_concept, code-anchored)', () => {
    for (const pin of FROZEN_PINS) {
        it(`${pin.code} -> ${pin.sidS}`, () => {
            expect(generateSID_S(LOINC_ENTITY_CLASS, pin.payload, LOINC_CANON_VERSION)).toBe(pin.sidS);
        });
    }
    it('SID-S is anchored on the CODE not any string (permanence)', () => {
        const a = generateSID_S(LOINC_ENTITY_CLASS, 'LNC:34084-4', LOINC_CANON_VERSION);
        const b = generateSID_S(LOINC_ENTITY_CLASS, 'LNC:34084-4', LOINC_CANON_VERSION);
        expect(a).toBe(b);
        expect(a).toBe('fcb5f8a230b0ae535b7dd7590dad9b22');
    });
    it('loinc_concept counter=1 SID-C pinned', () => {
        expect(generateSID_C(LOINC_ENTITY_CLASS, 1)).toBe('7bbcc7c95cdb309e1de11b039847b714');
    });
});

describe('Constants lock', () => {
    it('LOINC_ENTITY_CLASS = loinc_concept', () => {
        expect(LOINC_ENTITY_CLASS).toBe('loinc_concept');
    });
    it('LOINC_CANON_VERSION = loinc.concept.v1.0', () => {
        expect(LOINC_CANON_VERSION).toBe('loinc.concept.v1.0');
    });
});

describe('classifyLoincConcepts -- hard-fail invariant + crosswalk hit', () => {
    const emptyIndex = buildCrosswalkIndex([]);
    function makeConcept(overrides = {}) {
        return {
            code: '34084-4', cui: 'C0000001', sab: 'LNC', tty: 'LN',
            preferred_str: 'syn-placeholder', synonyms: [],
            anchor_payload: 'LNC:34084-4',
            canonicalization_version: 'loinc.concept.v1.0',
            ...overrides,
        };
    }

    it('valid concept -> unstamped on empty crosswalk', () => {
        const r = classifyLoincConcepts([makeConcept()], emptyIndex);
        expect(r.unstamped).toHaveLength(1);
        expect(r.unstamped[0].sidS).toBe('fcb5f8a230b0ae535b7dd7590dad9b22');
    });

    it('missing anchor_payload -> unstampable', () => {
        const r = classifyLoincConcepts([makeConcept({ anchor_payload: null })], emptyIndex);
        expect(r.unstampable).toHaveLength(1);
        expect(r.unstampable[0].reason).toBe(UNSTAMPABLE_REASON_MISSING_ANCHOR);
    });
    it('missing canonicalization_version -> unstampable', () => {
        expect(classifyLoincConcepts([makeConcept({ canonicalization_version: '' })], emptyIndex).unstampable).toHaveLength(1);
    });
    it('missing code -> unstampable', () => {
        expect(classifyLoincConcepts([makeConcept({ code: undefined })], emptyIndex).unstampable).toHaveLength(1);
    });

    it('crosswalk hit -> alreadyStamped', () => {
        const seed = [{
            sid_s: 'fcb5f8a230b0ae535b7dd7590dad9b22', sid_c: 'c'.repeat(32),
            entity_class: 'loinc_concept', canonicalization_version: 'loinc.concept.v1.0',
            canonical_identity_payload: 'LNC:34084-4',
            counter_value: 1, reservation_id: 'r1', issuance_at: '2026-06-03T00:00:00Z',
        }];
        const idx = buildCrosswalkIndex(seed);
        const r = classifyLoincConcepts([makeConcept()], idx);
        expect(r.alreadyStamped).toHaveLength(1);
        expect(r.alreadyStamped[0].sidC).toBe('c'.repeat(32));
    });
});

describe('buildLoincStampingEntries -- frozen sid_c pin + crosswalk fields', () => {
    it('counter=1 entry produces locked sid_c + loinc_concept crosswalk fields', () => {
        const unstamped = [{
            concept: { code: '34084-4' },
            sidS: 'fcb5f8a230b0ae535b7dd7590dad9b22',
            anchorPayload: 'LNC:34084-4',
            canonVersion: 'loinc.concept.v1.0',
        }];
        const entries = buildLoincStampingEntries({
            unstamped, counterStart: 1, reservationId: 'rid-1', issuanceAt: '2026-06-03T00:00:00Z',
        });
        expect(entries[0].sidC).toBe('7bbcc7c95cdb309e1de11b039847b714');
        expect(entries[0].code).toBe('34084-4');
        expect(entries[0].crosswalkEntry.entity_class).toBe('loinc_concept');
        expect(entries[0].crosswalkEntry.canonicalization_version).toBe('loinc.concept.v1.0');
        expect(entries[0].crosswalkEntry.canonical_identity_payload).toBe('LNC:34084-4');
        expect(entries[0].crosswalkEntry.counter_value).toBe(1);
    });
});

describe('applyStampsToLoinc -- keys on code + paranoia branch', () => {
    it('stamps by code', () => {
        const c = [{ code: '34084-4' }];
        const m = new Map([['34084-4', { sid_s: 'a', sid_c: 'b' }]]);
        const r = applyStampsToLoinc(c, m);
        expect(r.skippedParanoiaCount).toBe(0);
        expect(c[0].sid_s).toBe('a');
        expect(c[0].sid_c).toBe('b');
    });
    it('stampMap miss -> warn + skippedParanoiaCount++', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
        const c = [{ code: '34084-4' }, { code: '99999-9' }];
        const r = applyStampsToLoinc(c, new Map([['34084-4', { sid_s: 'a', sid_c: 'b' }]]));
        expect(r.skippedParanoiaCount).toBe(1);
        warnSpy.mockRestore();
    });
});

describe('buildLoincStampingSummary', () => {
    it('summary shape', () => {
        const s = buildLoincStampingSummary({
            totalConcepts: 306528, alreadyStamped: 0, newlyStamped: 306528, unstampable: 0,
            reservationsIssued: 7, skippedParanoiaCount: 0,
            elapsedMs: 100, ledgerKeys: ['k1'], shardCount: 1,
        });
        expect(s.total_concepts).toBe(306528);
        expect(s.newly_stamped).toBe(306528);
        expect(s.shard_count).toBe(1);
    });
});
