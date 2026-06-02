// @ts-nocheck
/**
 * PR-UMLS-1: shared umls-concept lib contract tests (network-free, synthetic MRCONSO rows).
 *
 * Locks the pure concept-extract core: column order, atom->concept precedence, synonym
 * collection, EXACT SAB matching (MSHFRE/MSHSWE must NOT match MSH), SUPPRESS/LAT filters,
 * the 3-SAB distinct-CODE measurement + ceiling check, the SID-S anchor fields, and the
 * trailing-pipe round-trip through the exported makeRrfParser.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    MRCONSO_COLUMNS, TARGET_SABS, MESH_SAB, MESH_CANONICALIZATION_VERSION, SNOMED_SAB, makeRrfParser,
    newConceptAccumulator, ingestMrconsoRow, finalizeConcepts,
} from '../../scripts/factory/lib/umls-concept-streams.js';

// DRIFT GUARD: the SNOMED rehydration tool (tools/snomed-rehydrate) vendors a COPY of
// the atomRank / collapse precedence below. It asserts the SAME shared fixture's
// expected_collapsed, so a precedence change in THIS lib that is not mirrored in the
// tool breaks one of the two tests. Keep the fixture single-sourced here.
const PRECEDENCE_FIXTURE = JSON.parse(
    readFileSync(new URL('../../tools/snomed-rehydrate/precedence.fixture.json', import.meta.url), 'utf-8'),
);

// Build a named-column MRCONSO row object (mirrors what makeRrfParser emits).
function row(overrides = {}) {
    const base = {
        CUI: 'C0000001', LAT: 'ENG', TS: 'P', LUI: 'L1', STT: 'PF', SUI: 'S1', ISPREF: 'Y',
        AUI: 'A1', SAUI: '', SCUI: '', SDUI: '', SAB: 'MSH', TTY: 'MH', CODE: 'D000001',
        STR: 'Concept One', SRL: '0', SUPPRESS: 'N', CVF: '',
    };
    return { ...base, ...overrides };
}

function ingestAll(rows, target = MESH_SAB) {
    const acc = newConceptAccumulator();
    for (const r of rows) ingestMrconsoRow(acc, r, target);
    return acc;
}

describe('1. MRCONSO_COLUMNS lock', () => {
    it('18 names in the verified order (CUI@0, SAB@11, TTY@12, CODE@13, STR@14)', () => {
        expect(MRCONSO_COLUMNS).toHaveLength(18);
        expect(MRCONSO_COLUMNS[0]).toBe('CUI');
        expect(MRCONSO_COLUMNS[11]).toBe('SAB');
        expect(MRCONSO_COLUMNS[12]).toBe('TTY');
        expect(MRCONSO_COLUMNS[13]).toBe('CODE');
        expect(MRCONSO_COLUMNS[14]).toBe('STR');
        expect(MRCONSO_COLUMNS).toEqual([
            'CUI', 'LAT', 'TS', 'LUI', 'STT', 'SUI', 'ISPREF', 'AUI', 'SAUI', 'SCUI',
            'SDUI', 'SAB', 'TTY', 'CODE', 'STR', 'SRL', 'SUPPRESS', 'CVF',
        ]);
        expect(TARGET_SABS).toEqual(['MSH', 'SNOMEDCT_US', 'LNC']);
    });
});

describe('2. atom -> concept precedence', () => {
    it('preferred (ISPREF=Y,TS=P,STT=PF) wins over lower-rank atoms regardless of order', () => {
        const acc = ingestAll([
            row({ CODE: 'D1', STR: 'lower rank', ISPREF: 'N', TS: 'S', STT: 'VO', SUI: 'Sx' }),
            row({ CODE: 'D1', STR: 'PREFERRED', ISPREF: 'Y', TS: 'P', STT: 'PF', SUI: 'Sy' }),
            row({ CODE: 'D1', STR: 'mid rank', ISPREF: 'Y', TS: 'P', STT: 'VO', SUI: 'Sz' }),
        ]);
        const c = finalizeConcepts(acc).concepts;
        expect(c).toHaveLength(1);
        expect(c[0].preferred_str).toBe('PREFERRED');
    });

    it('a CODE with NO preferred atom still yields a concept (rank-4 fallback, never silent-drop)', () => {
        const acc = ingestAll([
            row({ CODE: 'D2', STR: 'only non-preferred', ISPREF: 'N', TS: 'S', STT: 'VO' }),
        ]);
        const c = finalizeConcepts(acc).concepts;
        expect(c).toHaveLength(1);
        expect(c[0].code).toBe('D2');
        expect(c[0].preferred_str).toBe('only non-preferred');
    });
});

describe('3. synonym set', () => {
    it('non-preferred ENG STRs collected, deduped, preferred excluded', () => {
        const acc = ingestAll([
            row({ CODE: 'D3', STR: 'Preferred Name', ISPREF: 'Y', TS: 'P', STT: 'PF', SUI: 'A' }),
            row({ CODE: 'D3', STR: 'Syn A', ISPREF: 'N', TS: 'S', STT: 'VO', SUI: 'B' }),
            row({ CODE: 'D3', STR: 'Syn B', ISPREF: 'N', TS: 'S', STT: 'VO', SUI: 'C' }),
            row({ CODE: 'D3', STR: 'Syn A', ISPREF: 'N', TS: 'S', STT: 'VO', SUI: 'D' }),  // dup
            row({ CODE: 'D3', STR: 'Preferred Name', ISPREF: 'N', TS: 'S', STT: 'VO', SUI: 'E' }),  // == preferred
        ]);
        const c = finalizeConcepts(acc).concepts[0];
        expect(c.preferred_str).toBe('Preferred Name');
        expect(c.synonyms).toEqual(['Syn A', 'Syn B']);  // sorted, deduped, preferred excluded
    });

    it('when a better preferred atom arrives later, the old preferred string becomes a synonym', () => {
        const acc = ingestAll([
            row({ CODE: 'D3b', STR: 'first-seen P (rank2)', ISPREF: 'Y', TS: 'P', STT: 'VO', SUI: 'A' }),
            row({ CODE: 'D3b', STR: 'true PF (rank1)', ISPREF: 'Y', TS: 'P', STT: 'PF', SUI: 'B' }),
        ]);
        const c = finalizeConcepts(acc).concepts[0];
        expect(c.preferred_str).toBe('true PF (rank1)');
        expect(c.synonyms).toEqual(['first-seen P (rank2)']);
    });
});

describe('4. EXACT SAB match', () => {
    it('MSHFRE / MSHSWE do NOT enter MeSH byCode NOR the MSH distinct-CODE Set', () => {
        const acc = ingestAll([
            row({ CODE: 'X1', SAB: 'MSHFRE', STR: 'French' }),
            row({ CODE: 'X2', SAB: 'MSHSWE', STR: 'Swedish' }),
            row({ CODE: 'D9', SAB: 'MSH', STR: 'English MeSH' }),
        ]);
        const fin = finalizeConcepts(acc);
        expect(fin.concepts.map(c => c.code)).toEqual(['D9']);  // only the exact-MSH concept
        expect(fin.distinctCodeBySab.MSH).toBe(1);              // MSHFRE/MSHSWE not counted
    });
});

describe('5. SUPPRESS / LAT filters', () => {
    it('SUPPRESS !== N is dropped from the harvest', () => {
        const acc = ingestAll([
            row({ CODE: 'D10', SUPPRESS: 'O' }),
            row({ CODE: 'D10', SUPPRESS: 'E' }),
            row({ CODE: 'D11', SUPPRESS: 'N', STR: 'kept' }),
        ]);
        expect(finalizeConcepts(acc).concepts.map(c => c.code)).toEqual(['D11']);
    });

    it('LAT !== ENG is dropped from the harvest', () => {
        const acc = ingestAll([
            row({ CODE: 'D12', LAT: 'FRE', STR: 'francais' }),
            row({ CODE: 'D13', LAT: 'ENG', STR: 'english' }),
        ]);
        expect(finalizeConcepts(acc).concepts.map(c => c.code)).toEqual(['D13']);
    });
});

describe('6. distinct-CODE measurement (all 3 SABs, target-independent)', () => {
    it('same CODE 3x counts once; per-SAB isolation; runs regardless of harvest target', () => {
        // Harvest target = MSH, but the distinct-CODE counter still tallies SNOMED + LNC.
        const acc = ingestAll([
            row({ CODE: 'DUP', SAB: 'MSH', STR: 'a', SUI: 'A' }),
            row({ CODE: 'DUP', SAB: 'MSH', STR: 'b', SUI: 'B' }),
            row({ CODE: 'DUP', SAB: 'MSH', STR: 'c', SUI: 'C' }),
            row({ CODE: 'SN1', SAB: 'SNOMEDCT_US', STR: 's1' }),
            row({ CODE: 'SN2', SAB: 'SNOMEDCT_US', STR: 's2' }),
            row({ CODE: 'LN1', SAB: 'LNC', STR: 'l1' }),
            row({ CODE: 'OTHER', SAB: 'RXNORM', STR: 'ignored' }),
        ], MESH_SAB);
        const d = finalizeConcepts(acc).distinctCodeBySab;
        expect(d.MSH).toBe(1);            // DUP counted once
        expect(d.SNOMEDCT_US).toBe(2);    // SN1, SN2
        expect(d.LNC).toBe(1);            // LN1
    });

    it('a SNOMED CODE never increments MSH (per-SAB isolation)', () => {
        const acc = ingestAll([row({ CODE: 'SHARED', SAB: 'SNOMEDCT_US', STR: 'x' })]);
        const d = finalizeConcepts(acc).distinctCodeBySab;
        expect(d.MSH).toBe(0);
        expect(d.SNOMEDCT_US).toBe(1);
    });

    it('ceiling-check boolean: SNOMEDCT_US distinct < 1e6', () => {
        const acc = ingestAll([row({ CODE: 'SN', SAB: 'SNOMEDCT_US', STR: 'x' })]);
        const d = finalizeConcepts(acc).distinctCodeBySab;
        expect(d.SNOMEDCT_US < 1e6).toBe(true);
    });
});

describe('7. anchor fields', () => {
    it('anchor_payload === MSH:<code>, canonicalization_version === mesh.concept.v1.0, cui carried', () => {
        const acc = ingestAll([row({ CODE: 'D012711', CUI: 'C0000005', STR: 'Albumin', TTY: 'MH' })]);
        const c = finalizeConcepts(acc).concepts[0];
        expect(c.anchor_payload).toBe('MSH:D012711');
        expect(c.canonicalization_version).toBe('mesh.concept.v1.0');
        expect(c.canonicalization_version).toBe(MESH_CANONICALIZATION_VERSION);
        expect(c.sab).toBe('MSH');
        expect(c.cui).toBe('C0000005');   // CUI carried as the cross-link anchor (NOT identity key)
        expect(c.tty).toBe('MH');
    });

    it('all MSH record types harvested (D-descriptor / Q-qualifier / C-supplementary), no TTY filter', () => {
        const acc = ingestAll([
            row({ CODE: 'D000900', TTY: 'MH', STR: 'descriptor' }),
            row({ CODE: 'Q000009', TTY: 'QAB', STR: 'qualifier' }),
            row({ CODE: 'C000600', TTY: 'NM', STR: 'supplementary' }),
        ]);
        expect(finalizeConcepts(acc).concepts.map(c => c.code).sort())
            .toEqual(['C000600', 'D000900', 'Q000009']);
    });
});

describe('8. trailing-pipe round-trip through exported makeRrfParser', () => {
    it('a raw MRCONSO line with a TRAILING pipe maps the 18 named fields (19th absorbed)', async () => {
        const parser = makeRrfParser(MRCONSO_COLUMNS);
        // 18 fields + a trailing pipe -> 19 split-segments; relax_column_count absorbs #19.
        const line = 'C0000005|ENG|P|L0000005|PF|S0007492|Y|A26634265|||D012711|MSH|PEP|D012711|(131)I-Macroaggregated Albumin|0|N||\n';
        parser.write(line);
        parser.end();
        const rows = [];
        for await (const r of parser) rows.push(r);
        expect(rows).toHaveLength(1);
        const r = rows[0];
        expect(Object.keys(r)).toHaveLength(18);
        expect(r.CUI).toBe('C0000005');
        expect(r.SAB).toBe('MSH');
        expect(r.TTY).toBe('PEP');
        expect(r.CODE).toBe('D012711');
        expect(r.STR).toBe('(131)I-Macroaggregated Albumin');
        expect(r.SUPPRESS).toBe('N');
        expect(r.CVF).toBe('');

        // And it feeds straight into the pure core.
        const acc = newConceptAccumulator();
        ingestMrconsoRow(acc, r, MESH_SAB);
        const c = finalizeConcepts(acc).concepts[0];
        expect(c.code).toBe('D012711');
        expect(c.anchor_payload).toBe('MSH:D012711');
    });
});

describe('9. SNOMED rehydration-tool drift guard (shared precedence fixture)', () => {
    it('this pipeline collapse produces the SAME preferred_str + synonyms the tool pins', () => {
        // Feed the shared synthetic SNOMED fixture (CODE=99999001) through THIS lib's
        // collapse with target SAB=SNOMEDCT_US. If this precedence ever changes, the
        // tool's vendored copy must change too or its test fails -- and vice versa.
        const acc = newConceptAccumulator();
        for (const row of PRECEDENCE_FIXTURE.rows) ingestMrconsoRow(acc, row, SNOMED_SAB);
        const concepts = finalizeConcepts(acc, SNOMED_SAB, 'snomed.concept.v1.0').concepts;
        expect(concepts).toHaveLength(1);
        const c = concepts[0];
        const exp = PRECEDENCE_FIXTURE.expected_collapsed;
        expect(c.code).toBe(exp.code);
        expect(c.preferred_str).toBe(exp.preferred_str);
        expect([...c.synonyms].sort()).toEqual(exp.synonyms);
        expect(c.anchor_payload).toBe(`SNOMEDCT_US:${exp.code}`);
    });
});
