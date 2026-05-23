/**
 * Tests for cycle 22 PR-CORE-1 — Pattern E per-source × tier-class
 * completeness tracker.
 *
 * Locks the pure-function surface: required-field path resolution, gate
 * predicate evaluation, severity-tier classifier, registry shape, and
 * file-streaming aggregation against synthetic fixtures. R2 interactions
 * are exercised end-to-end by the workflow itself, not mocked here.
 *
 * Per [[no_shortcut_in_science]] quality leg: strict-enriched semantic
 * must reject records missing any one required field. These tests pin
 * that contract so future edits cannot silently loosen it.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import readline from 'readline';
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
    severityTierForPct,
    aggregateSeverity,
    listBelowThreshold,
    scanFile,
} from '../../scripts/factory/source-completeness.js';

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
            // denominator_gate is either null or a string dotted path
            if (entry.denominator_gate !== null) {
                expect(typeof entry.denominator_gate).toBe('string');
            }
        }
    });

    it('only RxNorm and OpenFDA FAERS have a UNII gate', () => {
        const gated = Object.entries(SOURCE_REQUIRED_FIELDS)
            .filter(([, e]) => e.denominator_gate !== null)
            .map(([id]) => id)
            .sort();
        expect(gated).toEqual(['openfda_faers', 'rxnorm']);
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

describe('isFullyEnriched against synthetic records', () => {
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
            id: 'x',
            pubchem_cid: 1,
            inchi_key: 'K',
            smiles_canonical: 'C',
            molecular_formula: 'C',
            molecular_weight: { value: null },
        };
        expect(isFullyEnriched(rec, pubchemEntry)).toBe(false);
    });

    it('UniChem entry requires both unii AND sources contains "unichem"', () => {
        const e = SOURCE_REQUIRED_FIELDS.unichem;
        expect(isFullyEnriched({ external_ids: { unii: 'X', sources: ['unichem'] } }, e)).toBe(true);
        expect(isFullyEnriched({ external_ids: { unii: 'X', sources: ['chembl'] } }, e)).toBe(false);
        expect(isFullyEnriched({ external_ids: { unii: null, sources: ['unichem'] } }, e)).toBe(false);
    });

    it('PubChem BioAssay requires has_pubchem_match === true (not falsy-but-defined)', () => {
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

describe('severityTierForPct boundary cases', () => {
    it('100% → tier 0 (healthy)', () => {
        expect(severityTierForPct(100)).toBe(0);
    });

    it('95% (exactly threshold) → tier 0', () => {
        expect(severityTierForPct(95)).toBe(0);
    });

    it('94.99% → tier 3 (info)', () => {
        expect(severityTierForPct(94.99)).toBe(3);
    });

    it('80% (exactly threshold) → tier 2 boundary → tier 0 if >=95 not met but >=80', () => {
        // 80 exactly is the warn lower bound → since pct < 95 it's tier 3 (info)
        expect(severityTierForPct(80)).toBe(3);
        expect(severityTierForPct(79.99)).toBe(2);
    });

    it('50% (exactly threshold) → tier 2 (warn) since < 80', () => {
        expect(severityTierForPct(50)).toBe(2);
        expect(severityTierForPct(49.99)).toBe(1);
    });

    it('0% → tier 1 (hardfail)', () => {
        expect(severityTierForPct(0)).toBe(1);
    });

    it('NaN → tier 1 (worst case, never silently pass)', () => {
        expect(severityTierForPct(NaN)).toBe(1);
        expect(severityTierForPct(undefined as unknown as number)).toBe(1);
    });
});

describe('aggregateSeverity + listBelowThreshold', () => {
    it('all healthy → tier 0, empty below', () => {
        const stats = {
            a: { gate_adjusted_pct: 99 },
            b: { gate_adjusted_pct: 96 },
        };
        expect(aggregateSeverity(stats as never)).toBe(0);
        expect(listBelowThreshold(stats as never)).toEqual([]);
    });

    it('one hardfail dominates regardless of others', () => {
        const stats = {
            a: { gate_adjusted_pct: 99 },
            b: { gate_adjusted_pct: 30 },
            c: { gate_adjusted_pct: 90 },
        };
        expect(aggregateSeverity(stats as never)).toBe(1);
        expect(listBelowThreshold(stats as never).sort()).toEqual(['b', 'c']);
    });

    it('worst of warn + info → tier 2', () => {
        const stats = {
            a: { gate_adjusted_pct: 90 },
            b: { gate_adjusted_pct: 70 },
        };
        expect(aggregateSeverity(stats as never)).toBe(2);
    });
});

async function lineStreamOf(jsonl: string) {
    const stream = Readable.from([jsonl]);
    return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

describe('scanFile streaming aggregation', () => {
    it('counts total records + per-source enriched against compounds-enriched.jsonl synthetic bundle', async () => {
        // 3 records: full pubchem+unichem+rxnorm; pubchem+unichem only (no UNII→no rxnorm gate);
        // pubchem only (missing UniChem entirely).
        const records = [
            {
                id: 'r1', pubchem_cid: 1, inchi_key: 'K1', smiles_canonical: 'C', molecular_formula: 'C',
                molecular_weight: { value: 1 },
                external_ids: { unii: 'U1', rxcui: '111', sources: ['unichem'] },
                drug_labels: [{ setid: 'X' }],
            },
            {
                id: 'r2', pubchem_cid: 2, inchi_key: 'K2', smiles_canonical: 'C', molecular_formula: 'C',
                molecular_weight: { value: 2 },
                external_ids: { unii: 'U2', rxcui: null, sources: ['unichem'] },
            },
            {
                id: 'r3', pubchem_cid: 3, inchi_key: 'K3', smiles_canonical: 'C', molecular_formula: 'C',
                molecular_weight: { value: 3 },
                external_ids: {},
            },
        ];
        const jsonl = records.map(r => JSON.stringify(r)).join('\n');
        const ls = await lineStreamOf(jsonl);

        // Build sources-for-this-file structure matching source-completeness.js
        const sources: Array<[string, {
            file: string;
            denominator_gate: string | null;
            required_paths: readonly string[];
            _stat: { total: number; gate_pass: number; fully_enriched: number };
        }]> = [];
        for (const [id, entry] of Object.entries(SOURCE_REQUIRED_FIELDS)) {
            if (entry.file !== 'compounds-enriched.jsonl') continue;
            sources.push([id, {
                file: entry.file,
                denominator_gate: entry.denominator_gate,
                required_paths: entry.required_paths,
                _stat: { total: 0, gate_pass: 0, fully_enriched: 0 },
            }]);
        }
        const { total, dailymedLinkedCompoundCount } = await scanFile(ls, sources);
        expect(total).toBe(3);
        expect(dailymedLinkedCompoundCount).toBe(1);

        const byId = Object.fromEntries(sources.map(([id, e]) => [id, e._stat]));
        // PubChem: all 3 fully enriched
        expect(byId.pubchem).toEqual({ total: 3, gate_pass: 3, fully_enriched: 3 });
        // UniChem: r1 + r2 have unii + sources contains 'unichem'; r3 missing both
        expect(byId.unichem.fully_enriched).toBe(2);
        // RxNorm gated by UNII: r1+r2 pass gate (have UNII), only r1 has rxcui
        expect(byId.rxnorm.gate_pass).toBe(2);
        expect(byId.rxnorm.fully_enriched).toBe(1);
        // FAERS gated by UNII: r1+r2 pass gate, none have fda_signals
        expect(byId.openfda_faers.gate_pass).toBe(2);
        expect(byId.openfda_faers.fully_enriched).toBe(0);
    });

    it('throws on malformed JSONL line (no silent skip)', async () => {
        const ls = await lineStreamOf('{"id":1}\nnot-json\n');
        const sources: Array<[string, {
            file: string;
            denominator_gate: string | null;
            required_paths: readonly string[];
            _stat: { total: number; gate_pass: number; fully_enriched: number };
        }]> = [];
        await expect(scanFile(ls, sources)).rejects.toThrow(/Malformed JSONL/);
    });

    it('skips blank lines without counting', async () => {
        const ls = await lineStreamOf('\n\n');
        const sources: Array<[string, {
            file: string;
            denominator_gate: string | null;
            required_paths: readonly string[];
            _stat: { total: number; gate_pass: number; fully_enriched: number };
        }]> = [];
        const { total } = await scanFile(ls, sources);
        expect(total).toBe(0);
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
