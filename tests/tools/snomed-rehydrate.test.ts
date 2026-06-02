// @ts-nocheck
/**
 * Tests for tools/snomed-rehydrate (network-free; NO real SNOMED strings).
 *
 * All synthetic MRCONSO rows use CODE=99999001, STR='Synthetic Concept ...',
 * SAB='SNOMEDCT_US'. The rehydration path is SID-S re-derive ONLY (no CUI).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
    sidS, snomedAnchorPayload, FROZEN_SID_S_PINS,
    SNOMED_ENTITY_CLASS, SNOMED_CANON_VERSION,
} from '../../tools/snomed-rehydrate/sid-derive.mjs';
import {
    splitRrfLine, atomRank, ingestSnomedRow, buildSidMap, MRCONSO_COLUMNS,
} from '../../tools/snomed-rehydrate/mrconso-join.mjs';
import {
    readSnomedPublic, readCrossLinkFile, collectCrossLinkSids,
} from '../../tools/snomed-rehydrate/snapshot-read.mjs';
import { rehydrateConcepts, resolveCrossLinks } from '../../tools/snomed-rehydrate/rehydrate.mjs';
import { generateSID_S } from '../../scripts/factory/lib/sid-generator.js';

const FIXTURE = JSON.parse(
    readFileSync(new URL('../../tools/snomed-rehydrate/precedence.fixture.json', import.meta.url), 'utf-8'),
);

// Build a raw MRCONSO line (trailing pipe) from a named-field object.
function rrfLine(row) {
    return MRCONSO_COLUMNS.map(c => row[c] ?? '').join('|') + '|';
}

function collapseFixture() {
    const byCode = new Map();
    for (const row of FIXTURE.rows) ingestSnomedRow(byCode, row);
    return byCode;
}

describe('1. parser round-trip (trailing pipe -> 18 fields)', () => {
    it('a raw line with a trailing pipe maps the 18 named columns', () => {
        const src = FIXTURE.rows[1];
        const row = splitRrfLine(rrfLine(src));
        expect(Object.keys(row)).toHaveLength(18);
        expect(row.CUI).toBe(src.CUI);
        expect(row.SAB).toBe('SNOMEDCT_US');
        expect(row.CODE).toBe('99999001');
        expect(row.STR).toBe('Synthetic Concept Preferred');
        expect(row.SUPPRESS).toBe('N');
    });
});

describe('2. atom->concept precedence parity (shared fixture)', () => {
    it('collapses to the pinned preferred_str + synonyms', () => {
        const byCode = collapseFixture();
        expect(byCode.size).toBe(1);
        const c = byCode.get('99999001');
        const synonyms = [...c.synonyms].sort();
        expect(c.preferred_str).toBe(FIXTURE.expected_collapsed.preferred_str);
        expect(synonyms).toEqual(FIXTURE.expected_collapsed.synonyms);
    });
    it('atomRank matches the documented precedence ladder', () => {
        expect(atomRank({ ISPREF: 'Y', TS: 'P', STT: 'PF' })).toBe(1);
        expect(atomRank({ ISPREF: 'Y', TS: 'P', STT: 'VO' })).toBe(2);
        expect(atomRank({ ISPREF: 'N', TS: 'P', STT: 'VO' })).toBe(3);
        expect(atomRank({ ISPREF: 'N', TS: 'S', STT: 'VO' })).toBe(4);
    });
});

describe('3. EXACT SAB / SUPPRESS / LAT filters exclude near-matches', () => {
    it('SNOMEDCT_VET / non-ENG / suppressed rows never enter', () => {
        const byCode = collapseFixture();
        const c = byCode.get('99999001');
        const allStrings = [c.preferred_str, ...c.synonyms];
        expect(allStrings).not.toContain('Vet edition (wrong SAB, dropped)');
        expect(allStrings).not.toContain('Concept francais (non-ENG, dropped)');
        expect(allStrings).not.toContain('Suppressed atom (dropped)');
    });
    it('a fresh non-target row is ignored', () => {
        const byCode = new Map();
        ingestSnomedRow(byCode, { SAB: 'MSH', SUPPRESS: 'N', LAT: 'ENG', CODE: 'D1', STR: 'x' });
        ingestSnomedRow(byCode, { SAB: 'SNOMEDCT_US', SUPPRESS: 'Y', LAT: 'ENG', CODE: 'D2', STR: 'x' });
        ingestSnomedRow(byCode, { SAB: 'SNOMEDCT_US', SUPPRESS: 'N', LAT: 'FRE', CODE: 'D3', STR: 'x' });
        expect(byCode.size).toBe(0);
    });
});

describe('4. sid-derive frozen pins', () => {
    it('computed sidS(code) == pinned for every frozen pin', () => {
        for (const [code, pin] of Object.entries(FROZEN_SID_S_PINS)) {
            expect(sidS(code)).toBe(pin);
        }
    });
    it('sidS(99999001) matches the fixture pin', () => {
        expect(sidS('99999001')).toBe(FIXTURE.expected_collapsed.sid_s);
    });
    it('mirrors generateSID_S exactly (same formula)', () => {
        const code = '99999001';
        const viaGenerator = generateSID_S(SNOMED_ENTITY_CLASS, snomedAnchorPayload(code), SNOMED_CANON_VERSION);
        expect(sidS(code)).toBe(viaGenerator);
        expect(snomedAnchorPayload(code)).toBe('SNOMEDCT_US:99999001');
    });
});

describe('snapshot read + rehydrate (temp dir, gz + plain)', () => {
    let dir;
    let localBySidS;
    const SID = FIXTURE.expected_collapsed.sid_s;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'snomed-rehydrate-'));
        // Public SNOMED concepts: {sid_s, sid_c} ONLY. One matching, one with no local code.
        const concepts = [
            JSON.stringify({ sid_s: SID, sid_c: 'cccccccccccccccccccccccccccccccc' }),
            JSON.stringify({ sid_s: 'deadbeefdeadbeefdeadbeefdeadbeef', sid_c: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
        ].join('\n') + '\n';
        writeFileSync(join(dir, 'snomed-concepts-public.jsonl.gz'), gzipSync(Buffer.from(concepts, 'utf-8')));
        // Disease cross-link referencing the matching sid (plain jsonl).
        const diseases = JSON.stringify({
            id: 'MONDO:0000001',
            snomed_links: [{ snomed_sid: SID, confidence: 1.0, match_method: 'exact_code_join' }],
        }) + '\n';
        writeFileSync(join(dir, 'diseases.jsonl'), diseases);

        const byCode = collapseFixture();
        localBySidS = buildSidMap(byCode).bySidS;
    });

    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    it('reads gzipped public artifact -> {sid_s, sid_c}', () => {
        const { records } = readSnomedPublic(dir);
        expect(records).toHaveLength(2);
        expect(records[0]).toEqual({ sid_s: SID, sid_c: 'cccccccccccccccccccccccccccccccc' });
    });

    it('5. rehydrate happy path: matching sid_s -> correct {code, preferred_str}', () => {
        const { records } = readSnomedPublic(dir);
        const { rehydrated, stats } = rehydrateConcepts(records, localBySidS);
        const hit = rehydrated.find(r => r.sid_s === SID);
        expect(hit.code).toBe('99999001');
        expect(hit.preferred_str).toBe(FIXTURE.expected_collapsed.preferred_str);
        expect(hit.synonyms).toEqual(FIXTURE.expected_collapsed.synonyms);
        expect(stats.sid_matched).toBe(1);
    });

    it('6. no-match: a published sid_s with no local code is counted, never dropped', () => {
        const { records } = readSnomedPublic(dir);
        const { rehydrated, stats } = rehydrateConcepts(records, localBySidS);
        expect(rehydrated).toHaveLength(2); // nothing dropped
        const miss = rehydrated.find(r => r.sid_s === 'deadbeefdeadbeefdeadbeefdeadbeef');
        expect(miss.no_sid_match).toBe(true);
        expect(miss.code).toBeNull();
        expect(stats.no_sid_match).toBe(1);
    });

    it('7. cross-link resolve: a disease snomed_link {snomed_sid} -> readable {code, preferred_str}', () => {
        const read = readCrossLinkFile(dir, 'diseases.jsonl');
        const sidMap = collectCrossLinkSids(read.records);
        const { resolved, stats } = resolveCrossLinks('diseases.jsonl', sidMap, localBySidS);
        expect(stats.sid_matched).toBe(1);
        const link = resolved.find(r => r.snomed_sid === SID);
        expect(link.code).toBe('99999001');
        expect(link.preferred_str).toBe(FIXTURE.expected_collapsed.preferred_str);
        expect(link.ref_count).toBe(1);
    });
});

describe('8. tool ships NO SNOMED content', () => {
    // Real SNOMED preferred terms for the frozen-pin SCTIDs (e.g. Diabetes mellitus =
    // 73211009, Hypertensive disorder = 38341003). Assert NONE appear in tool source.
    const FORBIDDEN_SNOMED_STRINGS = [
        'Diabetes mellitus', 'Hypertensive disorder', 'Asthma',
        'Pain', 'Disease', 'Disorder',
    ];
    const TOOL_FILES = [
        'sid-derive.mjs', 'mrconso-join.mjs', 'snapshot-read.mjs',
        'rehydrate.mjs', 'precedence.fixture.json',
    ];
    it('no real SNOMED preferred-term literal appears in any tool source file', () => {
        for (const f of TOOL_FILES) {
            const src = readFileSync(new URL(`../../tools/snomed-rehydrate/${f}`, import.meta.url), 'utf-8');
            for (const forbidden of FORBIDDEN_SNOMED_STRINGS) {
                expect(src.includes(forbidden)).toBe(false);
            }
        }
    });
    it('tool dir contains exactly the expected dependency-free source set', () => {
        const dirUrl = new URL('../../tools/snomed-rehydrate/', import.meta.url);
        const files = readdirSync(dirUrl).sort();
        expect(files).toEqual([
            'README.md', 'mrconso-join.mjs', 'precedence.fixture.json',
            'rehydrate.mjs', 'sid-derive.mjs', 'snapshot-read.mjs',
        ]);
    });
});
