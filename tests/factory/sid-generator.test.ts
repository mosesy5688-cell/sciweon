// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    generateSID_S, generateSID_C,
    smallMoleculeCanonicalAnchor,
    SID_LENGTH, NAMESPACE, SPEC_VERSION,
    SMALL_MOLECULE_CANONICALIZATION_VERSION,
} from '../../scripts/factory/lib/sid-generator.js';

// Reference SIDs computed under V1.0 §3.1 V0.8 algorithm for aspirin
// (acetylsalicylic acid free acid form, InChIKey BSYNRYMUTXBXSQ-UHFFFAOYSA-N).
// These constants are FROZEN — any algorithm change breaks them per V0.5
// §25 Canonicalization Versioning Doctrine. A breaking change requires
// canonicalization_version increment + SER superseded_by edges per V0.7
// §22 Permanence Doctrine.

const ASPIRIN_INCHIKEY = 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N';

describe('SID-S generation (V1.0 §3.1 V0.8 algorithm)', () => {
    it('produces a 32-char hex string per V0.5 §3.1', () => {
        const sid = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        expect(sid).toHaveLength(SID_LENGTH);
        expect(SID_LENGTH).toBe(32);
        expect(sid).toMatch(/^[0-9a-f]{32}$/);
    });

    it('is deterministic: same inputs -> same SID-S', () => {
        const sid1 = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        const sid2 = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        expect(sid1).toBe(sid2);
    });

    it('differs when entity_class differs (same anchor, different class -> different SID-S)', () => {
        const asSmallMol = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        const asPeptide = generateSID_S('peptide', `inchikey:${ASPIRIN_INCHIKEY}`, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        expect(asSmallMol).not.toBe(asPeptide);
    });

    it('differs when canonicalization_version differs (per V0.5 §25 upgrades)', () => {
        const v1 = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, 'compound.inchikey.v1.0');
        const v2 = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, 'compound.inchikey.v2.0');
        expect(v1).not.toBe(v2);
    });

    it('differs across compounds (different InChIKey -> different SID-S)', () => {
        const aspirin = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        const caffeine = generateSID_S('small_molecule', 'inchikey:RYYVLZVUVIJVGH-UHFFFAOYSA-N', SMALL_MOLECULE_CANONICALIZATION_VERSION);
        expect(aspirin).not.toBe(caffeine);
    });

    it('is publicly derivable: third party with anchor + version + class reproduces it', () => {
        // This is the V0.3 strategic-fork B commitment: open derivability.
        // The test is performative — anyone reading this test re-derives the
        // same SID-S on their machine. No secret state involved.
        const sid = generateSID_S('small_molecule', `inchikey:${ASPIRIN_INCHIKEY}`, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        // Frozen reference: SHA-256 of 'sciweon:small_molecule:compound.inchikey.v1.0:inchikey:BSYNRYMUTXBXSQ-UHFFFAOYSA-N' truncated to 32 hex chars
        // Anyone can verify this by running: echo -n "sciweon:small_molecule:compound.inchikey.v1.0:inchikey:BSYNRYMUTXBXSQ-UHFFFAOYSA-N" | sha256sum
        expect(sid).toBe('c1fe6bb77cec6b1e3ecd0061a5dc749e');
    });

    it('throws on missing/non-string entity_class', () => {
        expect(() => generateSID_S(null, 'anchor', 'v1.0')).toThrow(/entityClass/);
        expect(() => generateSID_S('', 'anchor', 'v1.0')).toThrow(/entityClass/);
        expect(() => generateSID_S(undefined, 'anchor', 'v1.0')).toThrow(/entityClass/);
    });

    it('throws on missing/non-string canonical_identity_payload', () => {
        expect(() => generateSID_S('small_molecule', null, 'v1.0')).toThrow(/canonicalIdentityPayload/);
        expect(() => generateSID_S('small_molecule', '', 'v1.0')).toThrow(/canonicalIdentityPayload/);
    });

    it('throws on missing/non-string canonicalization_version', () => {
        expect(() => generateSID_S('small_molecule', 'anchor', null)).toThrow(/canonicalizationVersion/);
        expect(() => generateSID_S('small_molecule', 'anchor', '')).toThrow(/canonicalizationVersion/);
    });
});

describe('SID-C generation (V1.0 §40 Distributed-Verifiable Counter Lock)', () => {
    it('produces a 32-char hex string', () => {
        const sid = generateSID_C('small_molecule', 1);
        expect(sid).toHaveLength(SID_LENGTH);
        expect(sid).toMatch(/^[0-9a-f]{32}$/);
    });

    it('is deterministic: same inputs -> same SID-C', () => {
        const sid1 = generateSID_C('small_molecule', 42);
        const sid2 = generateSID_C('small_molecule', 42);
        expect(sid1).toBe(sid2);
    });

    it('differs across counter values (monotonic ledger -> distinct SID-Cs)', () => {
        const sid1 = generateSID_C('small_molecule', 1);
        const sid2 = generateSID_C('small_molecule', 2);
        expect(sid1).not.toBe(sid2);
    });

    it('differs across entity classes (same counter, different class -> different SID-C)', () => {
        const asSmallMol = generateSID_C('small_molecule', 100);
        const asTrial = generateSID_C('trial', 100);
        expect(asSmallMol).not.toBe(asTrial);
    });

    it('accepts counter as bigint for large counter spaces', () => {
        const sid = generateSID_C('small_molecule', 100000000000n);
        expect(sid).toHaveLength(SID_LENGTH);
        expect(sid).toMatch(/^[0-9a-f]{32}$/);
    });

    it('is publicly derivable: given counter ledger entry, anyone re-derives', () => {
        const sid = generateSID_C('small_molecule', 1);
        // Frozen reference: SHA-256 of 'sciweon:small_molecule:1' truncated 32 hex
        expect(sid).toBe('9549658c8384b75a751de9d7eaa28d4d');
    });

    it('throws on missing/non-string entity_class', () => {
        expect(() => generateSID_C(null, 1)).toThrow(/entityClass/);
        expect(() => generateSID_C('', 1)).toThrow(/entityClass/);
    });

    it('throws on non-numeric counter', () => {
        expect(() => generateSID_C('small_molecule', 'abc')).toThrow(/Counter|number/);
        expect(() => generateSID_C('small_molecule', null)).toThrow();
    });

    it('throws on negative counter (monotonic invariant)', () => {
        expect(() => generateSID_C('small_molecule', -1)).toThrow(/non-negative/);
        expect(() => generateSID_C('small_molecule', -1n)).toThrow(/non-negative/);
    });

    it('throws on non-integer counter (counter is a discrete sequence)', () => {
        expect(() => generateSID_C('small_molecule', 1.5)).toThrow(/integer/);
        expect(() => generateSID_C('small_molecule', NaN)).toThrow(/integer/);
    });
});

describe('smallMoleculeCanonicalAnchor helper', () => {
    it('returns inchikey-prefixed payload string', () => {
        expect(smallMoleculeCanonicalAnchor(ASPIRIN_INCHIKEY)).toBe(`inchikey:${ASPIRIN_INCHIKEY}`);
    });

    it('throws on missing InChIKey (route to partially_defined_substance class instead)', () => {
        expect(() => smallMoleculeCanonicalAnchor(null)).toThrow(/InChIKey/);
        expect(() => smallMoleculeCanonicalAnchor('')).toThrow(/InChIKey/);
    });

    it('integrates with generateSID_S to produce stable aspirin SID', () => {
        const anchor = smallMoleculeCanonicalAnchor(ASPIRIN_INCHIKEY);
        const sid = generateSID_S('small_molecule', anchor, SMALL_MOLECULE_CANONICALIZATION_VERSION);
        expect(sid).toBe('c1fe6bb77cec6b1e3ecd0061a5dc749e');
    });
});

describe('SID architecture constants (V1.0 §3.1 + §35 + §40 locks)', () => {
    it('NAMESPACE locked to sciweon (V0.3 + V0.4 §7)', () => {
        expect(NAMESPACE).toBe('sciweon');
    });

    it('SPEC_VERSION at V1.0 ratification (per V0.5 §25)', () => {
        expect(SPEC_VERSION).toBe('1.0');
    });

    it('SID length = 32 hex (128-bit per V0.5 §3.1)', () => {
        expect(SID_LENGTH).toBe(32);
    });

    it('SMALL_MOLECULE_CANONICALIZATION_VERSION = compound.inchikey.v1.0 (V0.5 §25 lock)', () => {
        expect(SMALL_MOLECULE_CANONICALIZATION_VERSION).toBe('compound.inchikey.v1.0');
    });
});
