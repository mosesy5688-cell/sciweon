// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    NAMESPACE_SCIWEON_SAL, SAL_ASSERTION_ENTITY_CLASS, SAL_CANON_VERSION,
    SAL_ANCHOR_PREFIX, SAL_PAYLOAD_PREFIX,
    normalizePayloadField, canonicalSerializePayload, computeSalDeterministicUuid,
    buildCanonicalPayload, deriveSalAnchorFromPayload,
} from '../../scripts/factory/lib/sid-sal-stamping.js';

const SAMPLE_PAYLOAD = {
    assertion_class: 'bioactivity_association',
    subject_canonical_sid: 'a'.repeat(32),
    predicate: 'inhibits',
    object_canonical_sid: 'b'.repeat(32),
    primary_source: 'chembl_activity:12345',
};

describe('Namespace Invariance — architect-pinned production constant', () => {
    it('NAMESPACE_SCIWEON_SAL pinned to deterministic sha256-derived RFC 4122 v5 namespace UUID', () => {
        expect(NAMESPACE_SCIWEON_SAL).toBe('0032aae1-052d-5d09-97b1-5c5b091015dd');
    });
    it('NAMESPACE version digit forced to 5 (hash idx 12 skipped)', () => {
        expect(NAMESPACE_SCIWEON_SAL.charAt(14)).toBe('5');
    });
    it('NAMESPACE variant digit forced to 9 (hash idx 16 skipped)', () => {
        expect(NAMESPACE_SCIWEON_SAL.charAt(19)).toBe('9');
    });
});

describe('Constants lock', () => {
    it('SAL_ASSERTION_ENTITY_CLASS = sal_assertion', () => {
        expect(SAL_ASSERTION_ENTITY_CLASS).toBe('sal_assertion');
    });
    it('SAL_CANON_VERSION = sal.uuid.v1.0', () => {
        expect(SAL_CANON_VERSION).toBe('sal.uuid.v1.0');
    });
    it('SAL_ANCHOR_PREFIX = sal:assertion_v1:', () => {
        expect(SAL_ANCHOR_PREFIX).toBe('sal:assertion_v1:');
    });
    it('SAL_PAYLOAD_PREFIX = assertion_uuid:', () => {
        expect(SAL_PAYLOAD_PREFIX).toBe('assertion_uuid:');
    });
});

describe('normalizePayloadField', () => {
    it('trims whitespace', () => { expect(normalizePayloadField('  hello  ')).toBe('hello'); });
    it('lowercases ASCII', () => { expect(normalizePayloadField('HELLO')).toBe('hello'); });
    it('combines trim + lowercase', () => { expect(normalizePayloadField('  TREATS ')).toBe('treats'); });
    it('empty after trim → null', () => { expect(normalizePayloadField('   ')).toBeNull(); });
    it('non-string → null', () => {
        expect(normalizePayloadField(null)).toBeNull();
        expect(normalizePayloadField(undefined)).toBeNull();
        expect(normalizePayloadField(42)).toBeNull();
        expect(normalizePayloadField({})).toBeNull();
    });
});

describe('canonicalSerializePayload — sorted-key invariance', () => {
    it('keys serialized in alphabetical order', () => {
        const s = canonicalSerializePayload({ b: 1, a: 2, c: 3 });
        expect(s).toBe('{"a":2,"b":1,"c":3}');
    });
    it('different key insertion order → identical serialized output', () => {
        const p1 = { primary_source: 'p', assertion_class: 'c', predicate: 'pr', subject_canonical_sid: 's', object_canonical_sid: 'o' };
        const p2 = { object_canonical_sid: 'o', predicate: 'pr', primary_source: 'p', subject_canonical_sid: 's', assertion_class: 'c' };
        expect(canonicalSerializePayload(p1)).toBe(canonicalSerializePayload(p2));
    });
    it('non-object → throws', () => {
        expect(() => canonicalSerializePayload(null)).toThrow();
        expect(() => canonicalSerializePayload('str')).toThrow();
    });
});

describe('computeSalDeterministicUuid — open-derivability invariant', () => {
    it('same payload → same UUID across calls (determinism)', () => {
        expect(computeSalDeterministicUuid(SAMPLE_PAYLOAD)).toBe(computeSalDeterministicUuid(SAMPLE_PAYLOAD));
    });
    it('reordered keys → same UUID (sorted-key invariance)', () => {
        const reordered = {
            primary_source: SAMPLE_PAYLOAD.primary_source,
            object_canonical_sid: SAMPLE_PAYLOAD.object_canonical_sid,
            predicate: SAMPLE_PAYLOAD.predicate,
            subject_canonical_sid: SAMPLE_PAYLOAD.subject_canonical_sid,
            assertion_class: SAMPLE_PAYLOAD.assertion_class,
        };
        expect(computeSalDeterministicUuid(reordered)).toBe(computeSalDeterministicUuid(SAMPLE_PAYLOAD));
    });
    it('mutated assertion_class → different UUID', () => {
        expect(computeSalDeterministicUuid({ ...SAMPLE_PAYLOAD, assertion_class: 'clinical_indication' }))
            .not.toBe(computeSalDeterministicUuid(SAMPLE_PAYLOAD));
    });
    it('mutated subject_canonical_sid → different UUID', () => {
        expect(computeSalDeterministicUuid({ ...SAMPLE_PAYLOAD, subject_canonical_sid: 'c'.repeat(32) }))
            .not.toBe(computeSalDeterministicUuid(SAMPLE_PAYLOAD));
    });
    it('mutated predicate → different UUID', () => {
        expect(computeSalDeterministicUuid({ ...SAMPLE_PAYLOAD, predicate: 'binds' }))
            .not.toBe(computeSalDeterministicUuid(SAMPLE_PAYLOAD));
    });
    it('produced UUID is RFC 4122 v5 36-char format', () => {
        expect(computeSalDeterministicUuid(SAMPLE_PAYLOAD))
            .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe('buildCanonicalPayload — validation + normalization', () => {
    it('valid input → normalized payload, no missingField', () => {
        const r = buildCanonicalPayload({
            assertion_class: 'BIOACTIVITY_ASSOCIATION',
            subject_canonical_sid: '  AAA  ',
            predicate: ' Treats ',
            object_canonical_sid: 'bbb',
            primary_source: 'CHEMBL_ACTIVITY:1',
        });
        expect(r.missingField).toBeNull();
        expect(r.payload.assertion_class).toBe('bioactivity_association');
        expect(r.payload.subject_canonical_sid).toBe('aaa');
        expect(r.payload.predicate).toBe('treats');
        expect(r.payload.primary_source).toBe('chembl_activity:1');
    });
    it('missing subject_canonical_sid → missingField reported', () => {
        const r = buildCanonicalPayload({ ...SAMPLE_PAYLOAD, subject_canonical_sid: null });
        expect(r.payload).toBeNull();
        expect(r.missingField).toBe('subject_canonical_sid');
    });
    it('missing object_canonical_sid → missingField reported', () => {
        expect(buildCanonicalPayload({ ...SAMPLE_PAYLOAD, object_canonical_sid: '' }).missingField).toBe('object_canonical_sid');
    });
    it('missing predicate → missingField reported', () => {
        expect(buildCanonicalPayload({ ...SAMPLE_PAYLOAD, predicate: '   ' }).missingField).toBe('predicate');
    });
    it('null rawAssertion → missingField rawAssertion', () => {
        expect(buildCanonicalPayload(null).missingField).toBe('rawAssertion');
    });
});

describe('deriveSalAnchorFromPayload', () => {
    it('produces uuid + payload + anchor with correct prefixes', () => {
        const a = deriveSalAnchorFromPayload(buildCanonicalPayload(SAMPLE_PAYLOAD).payload);
        expect(a.canonVersion).toBe(SAL_CANON_VERSION);
        expect(a.payload).toBe(`${SAL_PAYLOAD_PREFIX}${a.uuid}`);
        expect(a.anchor).toBe(`${SAL_ANCHOR_PREFIX}${a.uuid}`);
    });
});
