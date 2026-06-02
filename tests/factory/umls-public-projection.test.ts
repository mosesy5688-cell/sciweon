// @ts-nocheck
/**
 * PR-UMLS-2a COMPLIANCE test (founder FINAL RULING, NON-NEGOTIABLE).
 *
 * projectUmlsPublic(vocab, record) is the SINGLE SSoT cui-withhold projection for all UMLS
 * public concept artifacts. This test pins the strict per-vocab allowlist so any future
 * widening (e.g. accidentally re-adding cui to MeSH, the original breach) is caught in CI:
 *
 *   SNOMED         -> EXACTLY {sid_s, sid_c}              (no cui / code / str)
 *   MESH | LOINC   -> EXACTLY {sid_s, sid_c, code, str}   (no cui; Cat-0 code+str kept)
 *   unknown vocab  -> throw [COMPLIANCE_FATAL]
 *   cui is ALWAYS absent; an extra input field NEVER leaks (allowlist, not denylist).
 */

import { describe, it, expect } from 'vitest';
import {
    projectUmlsPublic, SNOMED_PUBLIC_KEYS, CAT0_PUBLIC_KEYS,
} from '../../scripts/factory/lib/umls-public-projection.js';

// A FULL stamped internal concept (the kind the projection must strip down). The string
// values are synthetic placeholders -- NO real proprietary vocabulary text.
function fullConcept(overrides = {}) {
    return {
        code: 'D000818',
        cui: 'C0001688',
        sab: 'MSH',
        tty: 'PT',
        preferred_str: 'PREFERRED-STR-PLACEHOLDER',
        synonyms: ['SYN-PLACEHOLDER-1', 'SYN-PLACEHOLDER-2'],
        anchor_payload: 'MSH:D000818',
        canonicalization_version: 'mesh.concept.v1.0',
        sid_s: '40374b17c32e1493bd60b96c1c2bd2c6',
        sid_c: 'be507120e7ea5dcd273f57761fada499',
        ...overrides,
    };
}

describe('public-key allowlists are frozen + correct', () => {
    it('SNOMED_PUBLIC_KEYS === [sid_s, sid_c], frozen', () => {
        expect(SNOMED_PUBLIC_KEYS).toEqual(['sid_s', 'sid_c']);
        expect(Object.isFrozen(SNOMED_PUBLIC_KEYS)).toBe(true);
    });
    it('CAT0_PUBLIC_KEYS === [sid_s, sid_c, code, str], frozen', () => {
        expect(CAT0_PUBLIC_KEYS).toEqual(['sid_s', 'sid_c', 'code', 'str']);
        expect(Object.isFrozen(CAT0_PUBLIC_KEYS)).toBe(true);
    });
});

describe('projectUmlsPublic(SNOMED) -- exactly {sid_s, sid_c}', () => {
    it('output has EXACTLY the two allowlisted keys (no cui/code/str)', () => {
        const pub = projectUmlsPublic('SNOMED', fullConcept());
        expect(Object.keys(pub).sort()).toEqual(['sid_c', 'sid_s']);
        expect(pub.sid_s).toBe('40374b17c32e1493bd60b96c1c2bd2c6');
        expect(pub.sid_c).toBe('be507120e7ea5dcd273f57761fada499');
        for (const k of ['cui', 'code', 'str', 'preferred_str', 'synonyms', 'tty', 'sab']) {
            expect(Object.prototype.hasOwnProperty.call(pub, k)).toBe(false);
        }
        expect(pub.cui).toBeUndefined();
    });
});

describe('projectUmlsPublic(MESH) -- exactly {sid_s, sid_c, code, str}', () => {
    it('keeps code + str (Cat-0), drops cui', () => {
        const pub = projectUmlsPublic('MESH', fullConcept());
        expect(Object.keys(pub).sort()).toEqual(['code', 'sid_c', 'sid_s', 'str']);
        expect(pub.sid_s).toBe('40374b17c32e1493bd60b96c1c2bd2c6');
        expect(pub.code).toBe('D000818');
        expect(pub.str).toBe('PREFERRED-STR-PLACEHOLDER'); // str maps from preferred_str
        // cui ALWAYS dropped (the breach fix).
        expect(Object.prototype.hasOwnProperty.call(pub, 'cui')).toBe(false);
        expect(pub.cui).toBeUndefined();
        // synonyms intentionally OUT of the public payload.
        expect(Object.prototype.hasOwnProperty.call(pub, 'synonyms')).toBe(false);
    });

    it('string-scan: the input cui value NEVER appears in the output', () => {
        const input = fullConcept({ cui: 'C0011849' });
        const pub = projectUmlsPublic('MESH', input);
        expect(JSON.stringify(pub)).not.toContain('C0011849');
    });
});

describe('projectUmlsPublic(LOINC) -- same allowlist as MESH', () => {
    it('keeps code + str, drops cui', () => {
        const pub = projectUmlsPublic('LOINC', fullConcept({ code: '34084-4', sab: 'LNC' }));
        expect(Object.keys(pub).sort()).toEqual(['code', 'sid_c', 'sid_s', 'str']);
        expect(pub.code).toBe('34084-4');
        expect(pub.cui).toBeUndefined();
    });
});

describe('cui is ALWAYS dropped + allowlist never leaks an extra field', () => {
    it('SNOMED + MESH + LOINC all annihilate cui', () => {
        for (const vocab of ['SNOMED', 'MESH', 'LOINC']) {
            const pub = projectUmlsPublic(vocab, fullConcept());
            expect(pub.cui).toBeUndefined();
            expect(Object.prototype.hasOwnProperty.call(pub, 'cui')).toBe(false);
        }
    });

    it('an EXTRA future input field never leaks into ANY vocab projection', () => {
        const withExtra = fullConcept({ some_new_future_field: 'LEAK-ME', icd10: 'E11' });
        for (const vocab of ['SNOMED', 'MESH', 'LOINC']) {
            const pub = projectUmlsPublic(vocab, withExtra);
            expect(pub.some_new_future_field).toBeUndefined();
            expect(pub.icd10).toBeUndefined();
        }
        const snomed = projectUmlsPublic('SNOMED', withExtra);
        expect(Object.keys(snomed).sort()).toEqual(['sid_c', 'sid_s']);
        const mesh = projectUmlsPublic('MESH', withExtra);
        expect(Object.keys(mesh).sort()).toEqual(['code', 'sid_c', 'sid_s', 'str']);
    });

    it('does not mutate the input (pure)', () => {
        const input = fullConcept();
        const before = JSON.stringify(input);
        projectUmlsPublic('MESH', input);
        projectUmlsPublic('SNOMED', input);
        expect(JSON.stringify(input)).toBe(before);
    });
});

describe('unknown vocab -> COMPLIANCE_FATAL (fail-closed)', () => {
    it('throws with the COMPLIANCE_FATAL marker', () => {
        for (const bad of ['MSH', 'snomed', 'RXNORM', 'ICD10', '', undefined, null]) {
            expect(() => projectUmlsPublic(bad, fullConcept())).toThrow(/COMPLIANCE_FATAL/);
        }
    });
    it('names the offending vocabulary in the message', () => {
        expect(() => projectUmlsPublic('RXNORM', fullConcept())).toThrow(/RXNORM/);
    });
});
