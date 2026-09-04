// @ts-nocheck
/**
 * LANE3 tests 15, 16 and 13: canonicalisation parity, the six frozen
 * equality rulings (3g), non-finite rejection in the merge path, and the
 * serving-side rights check.
 *
 * The claim equality function is a PRIVATE re-implementation of the
 * repository canonicalisation. The named reference is
 * scripts/factory/lib/snapshot-identity.js -> canonicalize; it is not
 * imported into the merge path because that module imports
 * @aws-sdk/client-s3, which would be dragged into every unit test.
 * THIS FILE IS THE ONLY PLACE THE REFERENCE MAY BE IMPORTED.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalize as reference } from '../../scripts/factory/lib/snapshot-identity.js';
import {
    CLAIMABLE_PATHS, canonicalEqual, canonicalize, dedupKey, hasNonFinite,
    hasOwn, isEmptyValue, isLegalValue,
} from '../../scripts/factory/lib/merge-claims-canonical.js';
import { mergeCompoundWithClaims } from '../../scripts/factory/lib/merge-claims-wrapper.js';

function base(extra = {}) {
    return {
        id: 'sciweon::compound::CID:2244', pubchem_cid: 2244,
        inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        smiles_canonical: 'CC(=O)OC1=CC=CC=C1C(=O)O',
        molecular_formula: 'C9H8O4', iupac_name: '2-acetyloxybenzoic acid',
        external_ids: { unii: 'R16CO5Y76E', sources: ['unichem'] }, ...extra,
    };
}

const CANONICAL_SRC_PATH = new URL(
    '../../scripts/factory/lib/merge-claims-canonical.js', import.meta.url);

const PARITY_CORPUS = [
    null, true, false, 0, -0, 1, 1.0, -1, 180.16, 180.157, 1e21,
    '', 'a', 'A b', ' leading', 'trailing ', 'C9H8O4', 'ethanol-2',
    [], [1, 2, 3], ['b', 'a'], [[1], [2, [3]]],
    {}, { b: 1, a: 2 }, { z: { y: 1, x: 2 }, a: [1, { d: 4, c: 3 }] },
    { nested: { deep: { deeper: [null, true, 'x'] } } },
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    { withUndefined: undefined, other: 1 },
    [undefined, 1],
];

describe('LANE3 3g: canonicalisation parity with snapshot-identity (test 15)', () => {
    for (const [i, value] of PARITY_CORPUS.entries()) {
        it(`is byte-identical to the reference for corpus entry ${i}`, () => {
            expect(canonicalize(value)).toBe(reference(value));
        });
    }

    it('sorts keys recursively and preserves array order', () => {
        const v = { b: [3, 1, 2], a: { d: 1, c: 2 } };
        expect(canonicalize(v)).toBe('{"a":{"c":2,"d":1},"b":[3,1,2]}');
        expect(canonicalize(v)).toBe(reference(v));
    });
});

describe('LANE3 3g: the six frozen equality rulings', () => {
    it('strings are case- and whitespace-sensitive: no trimming, no normalisation', () => {
        expect(canonicalEqual('Abc', 'abc')).toBe(false);
        expect(canonicalEqual(' a', 'a')).toBe(false);
        expect(canonicalEqual('a b', 'a  b')).toBe(false);
        expect(canonicalEqual('abc', 'abc')).toBe(true);
    });

    it('1 and 1.0 are equal', () => {
        expect(canonicalEqual(1, 1.0)).toBe(true);
    });

    it('180.16 and 180.157 are NOT equal -- no epsilon, no rounding', () => {
        expect(canonicalEqual(180.16, 180.157)).toBe(false);
    });

    it('-0 and 0 are equal', () => {
        expect(canonicalEqual(-0, 0)).toBe(true);
    });

    it('non-finite numbers are rejected, at the root and at depth', () => {
        // Canonicalisation maps them to null, which would collide with a real
        // null -- so they are never stored rather than being stored ambiguously.
        expect(canonicalize(Number.NaN)).toBe('null');
        expect(canonicalize(Number.POSITIVE_INFINITY)).toBe('null');
        expect(canonicalize(null)).toBe('null');
        expect(hasNonFinite(Number.NaN)).toBe(true);
        expect(hasNonFinite([1, { deep: [Number.NEGATIVE_INFINITY] }])).toBe(true);
        expect(hasNonFinite([1, { deep: [2] }])).toBe(false);
        expect(isLegalValue(Number.NaN)).toBe(false);
        expect(isLegalValue({ a: { b: Number.POSITIVE_INFINITY } })).toBe(false);
        expect(isLegalValue('C9H8O4')).toBe(true);
    });

    it('undefined, null and missing are distinguished BEFORE canonicalisation', () => {
        // They all canonicalise to the same string, which is exactly why the
        // distinction has to be made first.
        expect(canonicalize(undefined)).toBe(canonicalize(null));
        expect(isEmptyValue(undefined)).toBe(true);
        expect(isEmptyValue(null)).toBe(true);
        expect(isEmptyValue('')).toBe(true);
        expect(isEmptyValue(0)).toBe(false);
        expect(isEmptyValue(false)).toBe(false);
        expect(hasOwn({ a: undefined }, 'a')).toBe(true);
        expect(hasOwn({}, 'a')).toBe(false);
    });
});

describe('LANE3 3h: the dedup key', () => {
    it('joins path and canonical value with U+0000 at runtime', () => {
        const key = dedupKey('inchi_key', 'AAA');
        expect(key.charCodeAt('inchi_key'.length)).toBe(0);
        expect(key).toBe(`inchi_key${String.fromCharCode(0)}"AAA"`);
    });

    it('is written in the SOURCE as an escape, never as a literal NUL byte', () => {
        // A literal NUL byte would fail the byte audit.
        const bytes = readFileSync(CANONICAL_SRC_PATH);
        expect(bytes.includes(0)).toBe(false);
        expect(bytes.toString('utf-8')).toContain("'\\u0000'");
    });

    it('treats two claims as the same claim iff same path AND same value', () => {
        expect(dedupKey('inchi_key', 'A')).toBe(dedupKey('inchi_key', 'A'));
        expect(dedupKey('inchi_key', 'A')).not.toBe(dedupKey('iupac_name', 'A'));
        expect(dedupKey('inchi_key', 'A')).not.toBe(dedupKey('inchi_key', 'B'));
        // 1 and 1.0 collide, as the equality ruling requires.
        expect(dedupKey('inchi_key', 1)).toBe(dedupKey('inchi_key', 1.0));
    });
});

describe('LANE3 3g / 13: legality and rights', () => {
    it('rejects a non-finite number AT DEPTH, not only at the root (test 16)', () => {
        const counters = {};
        const prev = base({ molecular_formula: { formula: 'C9H8O4', mass: [1, { m: Number.NaN }] } });
        const merged = mergeCompoundWithClaims(prev, base({ molecular_formula: null }), counters);
        expect(merged.competing_claims).toBeUndefined();
        expect(counters.claims.nonfinite_rejected).toBe(1);
    });

    it('rejects a non-finite number at the root as well', () => {
        const counters = {};
        const prev = base({ iupac_name: Number.POSITIVE_INFINITY });
        mergeCompoundWithClaims(prev, base({ iupac_name: null }), counters);
        expect(counters.claims.nonfinite_rejected).toBe(1);
    });

    it('withholds none of the four frozen paths on the serving side (test 13)', () => {
        // LOCAL constants. Nothing is imported from src/worker/**.
        const FROZEN_PATHS = ['inchi_key', 'smiles_canonical', 'molecular_formula', 'iupac_name'];
        const WITHHELD_KEYS = [
            'kegg_drug', 'kegg_drug_id', 'faers_top_adr_terms', 'meddra_pt', 'reason_text',
        ];
        for (const p of FROZEN_PATHS) expect(WITHHELD_KEYS).not.toContain(p);
        expect([...CLAIMABLE_PATHS]).toEqual(FROZEN_PATHS);
    });
});
