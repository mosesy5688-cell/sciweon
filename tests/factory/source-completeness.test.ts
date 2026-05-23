/**
 * Tests for source-completeness-helpers.js aggregation surface - cycle 22
 * PR-CORE-1. Pins severity-tier classifier, multi-source aggregation, and
 * streaming-pass aggregation against synthetic fixtures.
 *
 * R2 interactions (GetObject, PutObject, pointer reads) are exercised
 * end-to-end by the workflow itself, not mocked in unit tests.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import readline from 'readline';
import { SOURCE_REQUIRED_FIELDS } from '../../scripts/factory/lib/source-required-fields.js';
import {
    severityTierForPct,
    aggregateSeverity,
    listBelowThreshold,
    scanFile,
} from '../../scripts/factory/lib/source-completeness-helpers.js';

describe('severityTierForPct boundary cases', () => {
    it('100% -> tier 0 (healthy)', () => {
        expect(severityTierForPct(100)).toBe(0);
    });

    it('95% (exactly threshold) -> tier 0', () => {
        expect(severityTierForPct(95)).toBe(0);
    });

    it('94.99% -> tier 3 (info)', () => {
        expect(severityTierForPct(94.99)).toBe(3);
    });

    it('80% exactly -> tier 3 (info, since < 95)', () => {
        expect(severityTierForPct(80)).toBe(3);
        expect(severityTierForPct(79.99)).toBe(2);
    });

    it('50% exactly -> tier 2 (warn, since < 80)', () => {
        expect(severityTierForPct(50)).toBe(2);
        expect(severityTierForPct(49.99)).toBe(1);
    });

    it('0% -> tier 1 (hardfail)', () => {
        expect(severityTierForPct(0)).toBe(1);
    });

    it('NaN -> tier 1 (worst case, never silently pass)', () => {
        expect(severityTierForPct(NaN)).toBe(1);
        expect(severityTierForPct(undefined as unknown as number)).toBe(1);
    });
});

describe('aggregateSeverity + listBelowThreshold', () => {
    it('all healthy -> tier 0, empty below', () => {
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

    it('warn beats info (most-severe = lowest non-zero tier)', () => {
        const stats = {
            a: { gate_adjusted_pct: 90 },   // tier 3 info
            b: { gate_adjusted_pct: 70 },   // tier 2 warn
        };
        expect(aggregateSeverity(stats as never)).toBe(2);
    });
});

async function lineStreamOf(jsonl: string) {
    const stream = Readable.from([jsonl]);
    return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

describe('scanFile streaming aggregation', () => {
    it('counts total records + per-source enriched against synthetic compounds bundle', async () => {
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
        expect(byId.pubchem).toEqual({ total: 3, gate_pass: 3, fully_enriched: 3 });
        expect(byId.unichem.fully_enriched).toBe(2);
        expect(byId.rxnorm.gate_pass).toBe(2);
        expect(byId.rxnorm.fully_enriched).toBe(1);
        expect(byId.openfda_faers.gate_pass).toBe(2);
        expect(byId.openfda_faers.fully_enriched).toBe(0);
    });

    it('throws on malformed JSONL line (no silent skip)', async () => {
        const ls = await lineStreamOf('{"id":1}\nnot-json\n');
        await expect(scanFile(ls, [])).rejects.toThrow(/Malformed JSONL/);
    });

    it('skips blank lines without counting', async () => {
        const ls = await lineStreamOf('\n\n');
        const { total } = await scanFile(ls, []);
        expect(total).toBe(0);
    });
});
