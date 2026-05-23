/**
 * Tests for source-required-fields.js SSoT registry + per-source semantic
 * predicates - cycle 22 PR-CORE-1.
 *
 * Pins the registry shape (8 keys, file targets, gate presence) and the
 * encoding-aware predicate functions (getPath, checkRequiredPath, checkGate,
 * isFullyEnriched). Per [[no-shortcut-in-science]] quality leg: strict-
 * enriched semantic must reject records missing any one required field;
 * these tests freeze that contract against future loosening.
 */

import { describe, it, expect } from 'vitest';
import {
    SOURCE_REQUIRED_FIELDS,
    SEVERITY_THRESHOLDS,
    filesNeeded,
} from '../../scripts/factory/lib/source-required-fields.js';
import {
    getPath,
    checkRequiredPath,
    checkGate,
    isFullyEnriched,
} from '../../scripts/factory/lib/source-completeness-helpers.js';

describe('SOURCE_REQUIRED_FIELDS registry shape', () => {
    it('has exactly 8 source keys', () => {
        const keys = Object.keys(SOURCE_REQUIRED_FIELDS);
        expect(keys).toHaveLength(8);
        expect(keys.sort()).toEqual([
            'chembl',
            'chembl_bioactivity',
            'dailymed',
            'openfda_faers',
            'pubchem',
            'pubchem_bioassay',
            'rxnorm',
            'unichem',
        ]);
    });

    it('every entry declares file + denominator_gate + required_paths', () => {
        for (const [sourceId, entry] of Object.entries(SOURCE_REQUIRED_FIELDS)) {
            expect(entry.file, `${sourceId}.file`).toMatch(/\.jsonl$/);
            expect(['compounds-enriched.jsonl', 'bioactivities.jsonl', 'drug-labels.jsonl']).toContain(entry.file);
            expect(entry.required_paths.length, `${sourceId}.required_paths`).toBeGreaterThan(0);
            if (entry.denominator_gate !== null) {
                expect(typeof entry.denominator_gate).toBe('string');
            }
        }
    });

    it('gated sources: chembl (drug_status) + rxnorm + openfda_faers (UNII)', () => {
        const gated = Object.entries(SOURCE_REQUIRED_FIELDS)
            .filter(([, e]) => e.denominator_gate !== null)
            .map(([id]) => id)
            .sort();
        expect(gated).toEqual(['chembl', 'openfda_faers', 'rxnorm']);
        expect(SOURCE_REQUIRED_FIELDS.chembl.denominator_gate).toBe('drug_status');
    });

    it('filesNeeded returns the 3 distinct bundle files sorted', () => {
        expect(filesNeeded()).toEqual([
            'bioactivities.jsonl',
            'compounds-enriched.jsonl',
            'drug-labels.jsonl',
        ]);
    });
});

describe('getPath dotted-path resolver', () => {
    it('returns top-level field', () => {
        expect(getPath({ chembl_id: 'CHEMBL1' }, 'chembl_id')).toBe('CHEMBL1');
    });

    it('returns nested field', () => {
        expect(getPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
    });

    it('returns undefined for missing segment', () => {
        expect(getPath({ a: { b: {} } }, 'a.b.c')).toBeUndefined();
        expect(getPath({}, 'x.y.z')).toBeUndefined();
    });

    it('returns undefined when intermediate segment is null', () => {
        expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    });

    it('handles null record input safely', () => {
        expect(getPath(null, 'a')).toBeUndefined();
    });
});

describe('checkRequiredPath encoding', () => {
    it('plain dotted path requires non-null value', () => {
        expect(checkRequiredPath({ x: 1 }, 'x')).toBe(true);
        expect(checkRequiredPath({ x: 0 }, 'x')).toBe(true);
        expect(checkRequiredPath({ x: '' }, 'x')).toBe(true);
        expect(checkRequiredPath({ x: false }, 'x')).toBe(true);
        expect(checkRequiredPath({ x: null }, 'x')).toBe(false);
        expect(checkRequiredPath({}, 'x')).toBe(false);
    });

    it('[] suffix requires array length >= 1', () => {
        expect(checkRequiredPath({ a: [1] }, 'a[]')).toBe(true);
        expect(checkRequiredPath({ a: [] }, 'a[]')).toBe(false);
        expect(checkRequiredPath({ a: null }, 'a[]')).toBe(false);
        expect(checkRequiredPath({}, 'a[]')).toBe(false);
        expect(checkRequiredPath({ a: 'not-array' }, 'a[]')).toBe(false);
    });

    it('===literal suffix requires strict equality', () => {
        expect(checkRequiredPath({ ok: true }, 'ok===true')).toBe(true);
        expect(checkRequiredPath({ ok: false }, 'ok===true')).toBe(false);
        expect(checkRequiredPath({ ok: 'true' }, 'ok===true')).toBe(false);
        expect(checkRequiredPath({}, 'ok===true')).toBe(false);
    });

    it('~~literal suffix requires array.includes(literal)', () => {
        expect(checkRequiredPath({ srcs: ['unichem', 'chembl'] }, 'srcs~~"unichem"')).toBe(true);
        expect(checkRequiredPath({ srcs: ['chembl'] }, 'srcs~~"unichem"')).toBe(false);
        expect(checkRequiredPath({ srcs: 'unichem' }, 'srcs~~"unichem"')).toBe(false);
        expect(checkRequiredPath({}, 'srcs~~"unichem"')).toBe(false);
    });
});

describe('checkGate', () => {
    it('null gate always passes', () => {
        expect(checkGate({}, null)).toBe(true);
        expect(checkGate({ external_ids: { unii: null } }, null)).toBe(true);
    });

    it('UNII gate passes when external_ids.unii is non-null', () => {
        expect(checkGate({ external_ids: { unii: 'ABC123' } }, 'external_ids.unii')).toBe(true);
    });

    it('UNII gate fails when external_ids.unii is missing or null', () => {
        expect(checkGate({ external_ids: { unii: null } }, 'external_ids.unii')).toBe(false);
        expect(checkGate({ external_ids: {} }, 'external_ids.unii')).toBe(false);
        expect(checkGate({}, 'external_ids.unii')).toBe(false);
    });
});

describe('isFullyEnriched per-source semantics', () => {
    const pubchemEntry = SOURCE_REQUIRED_FIELDS.pubchem;

    it('passes when every required path resolves to non-null', () => {
        const rec = {
            id: 'sciweon::compound::cid::1',
            pubchem_cid: 1,
            inchi_key: 'KEY',
            smiles_canonical: 'CCO',
            molecular_formula: 'C2H6O',
            molecular_weight: { value: 46.07 },
        };
        expect(isFullyEnriched(rec, pubchemEntry)).toBe(true);
    });

    it('fails when one required nested field is null', () => {
        const rec = {
            id: 'x', pubchem_cid: 1, inchi_key: 'K', smiles_canonical: 'C',
            molecular_formula: 'C', molecular_weight: { value: null },
        };
        expect(isFullyEnriched(rec, pubchemEntry)).toBe(false);
    });

    it('ChEMBL entry requires drug_status fields (gate filters non-drug matches)', () => {
        const e = SOURCE_REQUIRED_FIELDS.chembl;
        // Full drug_status block -> enriched
        expect(isFullyEnriched({
            drug_status: { withdrawn: false, black_box_warning: true },
        }, e)).toBe(true);
        // Missing one field -> not enriched
        expect(isFullyEnriched({
            drug_status: { withdrawn: false, black_box_warning: null },
        }, e)).toBe(false);
        // drug_status=null means non-drug ChEMBL match; predicate fails but
        // the gate (denominator_gate='drug_status') also fails so this
        // record is excluded from the denominator at the tracker level.
        expect(isFullyEnriched({ chembl_id: 'CHEMBL1', drug_status: null }, e)).toBe(false);
        expect(checkGate({ chembl_id: 'CHEMBL1', drug_status: null }, e.denominator_gate)).toBe(false);
        // Compound with drug_status block passes the gate even before
        // required-field check.
        expect(checkGate({
            drug_status: { withdrawn: false, black_box_warning: false },
        }, e.denominator_gate)).toBe(true);
    });

    it('UniChem entry requires both unii AND sources contains "unichem"', () => {
        const e = SOURCE_REQUIRED_FIELDS.unichem;
        expect(isFullyEnriched({ external_ids: { unii: 'X', sources: ['unichem'] } }, e)).toBe(true);
        expect(isFullyEnriched({ external_ids: { unii: 'X', sources: ['chembl'] } }, e)).toBe(false);
        expect(isFullyEnriched({ external_ids: { unii: null, sources: ['unichem'] } }, e)).toBe(false);
    });

    it('PubChem BioAssay requires has_pubchem_match === true', () => {
        const e = SOURCE_REQUIRED_FIELDS.pubchem_bioassay;
        expect(isFullyEnriched({ cross_source_consensus: { has_pubchem_match: true } }, e)).toBe(true);
        expect(isFullyEnriched({ cross_source_consensus: { has_pubchem_match: false } }, e)).toBe(false);
        expect(isFullyEnriched({ cross_source_consensus: {} }, e)).toBe(false);
        expect(isFullyEnriched({}, e)).toBe(false);
    });

    it('OpenFDA FAERS requires non-empty terms array AND total_top_count', () => {
        const e = SOURCE_REQUIRED_FIELDS.openfda_faers;
        expect(isFullyEnriched({
            fda_signals: { faers_top_adr_terms: ['HEADACHE'], faers_total_top_count: 100 },
        }, e)).toBe(true);
        expect(isFullyEnriched({
            fda_signals: { faers_top_adr_terms: [], faers_total_top_count: 0 },
        }, e)).toBe(false);
        expect(isFullyEnriched({
            fda_signals: { faers_top_adr_terms: ['X'], faers_total_top_count: null },
        }, e)).toBe(false);
    });
});

describe('SEVERITY_THRESHOLDS contract', () => {
    it('hardfail < warn < info', () => {
        expect(SEVERITY_THRESHOLDS.hardfail).toBeLessThan(SEVERITY_THRESHOLDS.warn);
        expect(SEVERITY_THRESHOLDS.warn).toBeLessThan(SEVERITY_THRESHOLDS.info);
    });

    it('values match plan D7 (50/80/95)', () => {
        expect(SEVERITY_THRESHOLDS.hardfail).toBe(50);
        expect(SEVERITY_THRESHOLDS.warn).toBe(80);
        expect(SEVERITY_THRESHOLDS.info).toBe(95);
    });
});
