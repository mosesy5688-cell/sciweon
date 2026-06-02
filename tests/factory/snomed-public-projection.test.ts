// @ts-nocheck
/**
 * PR-UMLS-3 COMPLIANCE test (RULING 1, founder NON-NEGOTIABLE).
 *
 * projectSnomedPublic MUST emit EXACTLY {sid_s, sid_c} -- a strict ALLOWLIST. The
 * SNOMED-proprietary payload (CUI / STR / raw CODE / tty / sab / synonyms / preferred_str /
 * anchor_payload) is annihilated by construction. An extra input field still yields the
 * 2-key shape. This test is the CI gate that catches any future allowlist widening (e.g.
 * accidentally re-adding CUI), which would be a redistribution breach.
 */

import { describe, it, expect } from 'vitest';
import {
    projectSnomedPublic, SNOMED_PUBLIC_ALLOWLIST,
} from '../../scripts/factory/lib/snomed-public-projection.js';

// A FULL stamped internal SNOMED concept (the kind the projection must strip down).
// STR/preferred_str/synonyms are synthetic placeholders -- NO real SNOMED strings.
function fullConcept(overrides = {}) {
    return {
        code: '73211009',
        cui: 'C0011849',
        sab: 'SNOMEDCT_US',
        tty: 'PT',
        preferred_str: 'PROPRIETARY-STR-PLACEHOLDER',
        synonyms: ['SYN-PLACEHOLDER-1', 'SYN-PLACEHOLDER-2'],
        anchor_payload: 'SNOMEDCT_US:73211009',
        canonicalization_version: 'snomed.concept.v1.0',
        sid_s: 'a409595b11d0aabe31aecd559a84e04a',
        sid_c: '6c73f8b801ffc7d25733836ead05408b',
        ...overrides,
    };
}

const FORBIDDEN_KEYS = [
    'cui', 'code', 'preferred_str', 'str', 'synonyms', 'tty', 'sab', 'anchor_payload',
    'canonicalization_version',
];

describe('SNOMED_PUBLIC_ALLOWLIST lock', () => {
    it('is exactly [sid_s, sid_c] and frozen', () => {
        expect(SNOMED_PUBLIC_ALLOWLIST).toEqual(['sid_s', 'sid_c']);
        expect(Object.isFrozen(SNOMED_PUBLIC_ALLOWLIST)).toBe(true);
    });
});

describe('projectSnomedPublic -- output keys === exactly {sid_s, sid_c}', () => {
    it('output has EXACTLY the two allowlisted keys', () => {
        const pub = projectSnomedPublic(fullConcept());
        expect(Object.keys(pub).sort()).toEqual(['sid_c', 'sid_s']);
        expect(pub.sid_s).toBe('a409595b11d0aabe31aecd559a84e04a');
        expect(pub.sid_c).toBe('6c73f8b801ffc7d25733836ead05408b');
    });

    it('NO cui / code / str / preferred_str / synonyms / tty / sab key is present (CUI annihilated)', () => {
        const pub = projectSnomedPublic(fullConcept());
        for (const k of FORBIDDEN_KEYS) {
            expect(Object.prototype.hasOwnProperty.call(pub, k)).toBe(false);
        }
        // Explicit CUI annihilation assertion (the escalated final ruling).
        expect(pub.cui).toBeUndefined();
    });

    it('an EXTRA input field still yields only the 2-key allowlist (future field cannot leak)', () => {
        const pub = projectSnomedPublic(fullConcept({ some_new_future_field: 'LEAK-ME', icd10: 'E11' }));
        expect(Object.keys(pub).sort()).toEqual(['sid_c', 'sid_s']);
        expect(pub.some_new_future_field).toBeUndefined();
        expect(pub.icd10).toBeUndefined();
    });

    it('string-scan: no input STR / preferred_str / synonym text appears anywhere in the output', () => {
        const input = fullConcept();
        const pub = projectSnomedPublic(input);
        const serialized = JSON.stringify(pub);
        expect(serialized).not.toContain(input.preferred_str);
        for (const syn of input.synonyms) expect(serialized).not.toContain(syn);
        expect(serialized).not.toContain(input.cui);
        expect(serialized).not.toContain(input.code);
    });

    it('does not mutate the input (pure)', () => {
        const input = fullConcept();
        const before = JSON.stringify(input);
        projectSnomedPublic(input);
        expect(JSON.stringify(input)).toBe(before);
    });

    it('null / non-object input -> still a 2-key object (no throw)', () => {
        for (const bad of [null, undefined, 42, 'x']) {
            const pub = projectSnomedPublic(bad);
            expect(Object.keys(pub).sort()).toEqual(['sid_c', 'sid_s']);
        }
    });
});
