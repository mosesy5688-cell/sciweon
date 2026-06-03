/**
 * PR-OT-6 (2026-06-03) tests -- open_targets completeness denominator
 * re-scope (chembl_id -> drug_status) + scope-boundary telemetry.
 *
 * Split out of source-completeness.test.ts to keep that file under the Art 5.1
 * 250-line cap (same pattern as per-source-thresholds.test.ts).
 *
 * Re-scope semantics: OT only enriches KNOWN DRUGS, so the eligible
 * denominator is the drug_status-bearing set (mirroring the chembl source),
 * NOT the wider chembl_id-bearing set (most of which are non-drug bioactivity
 * references). The chembl_id-bearing-but-not-drug set is surfaced as explicit
 * scope_boundary_* telemetry so it is never silently dropped from the metric.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import readline from 'readline';
import { SOURCE_REQUIRED_FIELDS } from '../../scripts/factory/lib/source-required-fields.js';
import { scanFile, initStat } from '../../scripts/factory/lib/source-completeness-helpers.js';

async function lineStreamOf(jsonl: string) {
    const stream = Readable.from([jsonl]);
    return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

// Build the open_targets working entry the same way source-completeness.js
// buildWorking() does (gate + required_paths from the registry; _stat from
// initStat, which stamps scope_boundary_gate). Drive scanFile over a fixture.
type OtStat = {
    file: string; total: number; gate_pass: number; fully_enriched: number;
    raw_pct: number; gate_adjusted_pct: number;
    scope_boundary_gate: string; scope_boundary_pass: number; scope_boundary_excluded: number;
};

async function scanOtFixture(records: Record<string, unknown>[]): Promise<OtStat> {
    const entry = SOURCE_REQUIRED_FIELDS.open_targets;
    const working = {
        file: entry.file,
        denominator_gate: entry.denominator_gate,
        required_paths: entry.required_paths,
        _stat: initStat(entry),
    };
    const jsonl = records.map(r => JSON.stringify(r)).join('\n');
    const ls = await lineStreamOf(jsonl);
    await scanFile(ls, [['open_targets', working]] as never);
    return working._stat as OtStat;
}

describe('PR-OT-6 open_targets denominator re-scope (chembl_id -> drug_status)', () => {
    it('registry: gate is drug_status; numerator path + 10/20/35 thresholds unchanged', () => {
        const ot = SOURCE_REQUIRED_FIELDS.open_targets;
        expect(ot.denominator_gate).toBe('drug_status');
        expect(ot.required_paths).toEqual(['known_drug_info.chembl_id']);
        expect((ot as { scope_boundary_gate?: string }).scope_boundary_gate).toBe('chembl_id');
        expect(ot.severity_thresholds).toEqual({ hardfail: 10, warn: 20, info: 35 });
    });

    it('chembl_id but NO drug_status: out of OT scope -> gate_pass NOT incremented', async () => {
        const stat = await scanOtFixture([
            { id: 'c1', chembl_id: 'CHEMBL1' }, // bioactivity reference, not a drug
        ]);
        expect(stat.total).toBe(1);
        expect(stat.gate_pass).toBe(0);      // re-scope: drug_status absent -> not eligible
        expect(stat.fully_enriched).toBe(0);
    });

    it('drug_status + known_drug_info.chembl_id: increments BOTH gate_pass and fully_enriched', async () => {
        const stat = await scanOtFixture([
            { id: 'c1', chembl_id: 'CHEMBL1', drug_status: { withdrawn: false }, known_drug_info: { chembl_id: 'CHEMBL1' } },
        ]);
        expect(stat.gate_pass).toBe(1);
        expect(stat.fully_enriched).toBe(1);
    });

    it('drug_status but NO known_drug_info: honest in-scope gap -> gate_pass ONLY', async () => {
        const stat = await scanOtFixture([
            { id: 'c1', chembl_id: 'CHEMBL1', drug_status: { withdrawn: false } }, // eligible, not yet OT-enriched
        ]);
        expect(stat.gate_pass).toBe(1);
        expect(stat.fully_enriched).toBe(0);  // counted, never hidden
    });
});

describe('PR-OT-6 scope-boundary telemetry (chembl_id ^ !drug_status)', () => {
    const mixed = [
        // a: in scope + enriched -> gate_pass, fully_enriched, boundary-pass
        { id: 'a', chembl_id: 'CHEMBL_A', drug_status: { withdrawn: false }, known_drug_info: { chembl_id: 'CHEMBL_A' } },
        // b: in scope, not enriched -> gate_pass only, boundary-pass
        { id: 'b', chembl_id: 'CHEMBL_B', drug_status: { withdrawn: true } },
        // c: chembl_id but NO drug_status -> OUT of scope (boundary-excluded)
        { id: 'c', chembl_id: 'CHEMBL_C' },
        // d: chembl_id but NO drug_status -> OUT of scope (boundary-excluded)
        { id: 'd', chembl_id: 'CHEMBL_D' },
        // e: neither chembl_id nor drug_status -> not in boundary set at all
        { id: 'e' },
    ];

    it('emits correct scope-boundary counters on a mixed fixture', async () => {
        const stat = await scanOtFixture(mixed);
        expect(stat.total).toBe(5);
        expect(stat.gate_pass).toBe(2);                 // a + b (drug_status present)
        expect(stat.fully_enriched).toBe(1);            // a only
        expect(stat.scope_boundary_gate).toBe('chembl_id');
        expect(stat.scope_boundary_pass).toBe(4);       // a,b,c,d chembl_id-bearing
        expect(stat.scope_boundary_excluded).toBe(2);   // c,d: chembl_id ^ !drug_status
    });

    it('boundary fields are an additive superset appended after gate_adjusted_pct', async () => {
        const stat = await scanOtFixture(mixed);
        const keys = Object.keys(stat);
        expect(keys.slice(0, 6)).toEqual(
            ['file', 'total', 'gate_pass', 'fully_enriched', 'raw_pct', 'gate_adjusted_pct'],
        );
        expect(keys.slice(6)).toEqual(
            ['scope_boundary_gate', 'scope_boundary_pass', 'scope_boundary_excluded'],
        );
    });

    it('sources WITHOUT scope_boundary_gate keep the exact legacy stat shape', () => {
        const stat = initStat(SOURCE_REQUIRED_FIELDS.pubchem) as Record<string, unknown>;
        expect(Object.keys(stat)).toEqual(
            ['file', 'total', 'gate_pass', 'fully_enriched', 'raw_pct', 'gate_adjusted_pct'],
        );
        expect('scope_boundary_excluded' in stat).toBe(false);
    });

    it('determinism: re-running the audit over the same fixture is byte-identical', async () => {
        const a = await scanOtFixture(mixed);
        const b = await scanOtFixture(mixed);
        expect(JSON.stringify(a, null, 2)).toBe(JSON.stringify(b, null, 2));
    });
});
