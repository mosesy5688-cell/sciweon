// @ts-nocheck
/**
 * PR-UNIPROT-0: tests for the SwissProt diagnostic probe's PURE helpers.
 *
 * SYNTHETIC fixtures only (fabricated entries, real EMBL/SwissProt line codes
 * ID/AC/DE/GN/OS/OX/CC/DR/SQ/// -- NO real UniProt content). These lock the DIAGNOSTIC
 * helper MECHANISM (// splitter / TENTATIVE field extraction / taxon tally incl. the
 * no-OX silent-drop guard / determinism), NOT a production ingest field mapping. The
 * production parser is PR-UNIPROT-1, grounded in the field map THIS probe verifies.
 */

import { describe, it, expect } from 'vitest';
import {
    splitRecordBlocks, isNonEmptyBlock, extractFieldMapTentative, parseTaxId,
    newTaxonTally, tallyTaxon, newDrSourceTally, tallyDrSources, topDrSources,
    hasCcByLicense, RECORD_DELIMITER, TARGET_TAXA, REST_TOTAL_BASELINE,
} from '../../scripts/factory/lib/uniprot-sprot-probe.js';

// --- SYNTHETIC fixtures (fabricated, NOT real UniProt records) ----------------------
const ENTRY_HUMAN = [
    'ID   FAKE1_HUMAN             Reviewed;         123 AA.',
    'AC   Q00001; Q00099;',
    'DE   RecName: Full=Fake human protein one;',
    'DE            EC=1.2.3.4;',
    'GN   Name=FAKE1; Synonyms=FK1;',
    'OS   Homo sapiens (Human).',
    'OX   NCBI_TaxID=9606 {ECO:0000312};',
    'DR   PDB; 1ABC; X-ray; 2.00 A; A=1-123.',
    'DR   AlphaFoldDB; Q00001; -.',
    'CC   -----------------------------------------------------------------------',
    'CC   Copyrighted by the UniProt Consortium, see https://www.uniprot.org/terms',
    'CC   Distributed under the Creative Commons Attribution (CC BY 4.0) License',
    'SQ   SEQUENCE   123 AA;  13456 MW;  ABCDEF1234567890 CRC64;',
    '     MKTAYIAKQR QISFVKSHFS RQLEERLGLI EVQAPILSRV GDGTQDNLSG',
].join('\n');

const ENTRY_MOUSE = [
    'ID   FAKE2_MOUSE             Reviewed;          88 AA.',
    'AC   P00002;',
    'DE   RecName: Full=Fake mouse protein two;',
    'GN   Name=Fake2;',
    'OS   Mus musculus (Mouse).',
    'OX   NCBI_TaxID=10090;',
    'DR   PDB; 2XYZ; NMR; -; B=1-88.',
    'SQ   SEQUENCE    88 AA;   9876 MW;  1122334455667788 CRC64;',
    '     GDGTQDNLSG MKTAYIAKQR',
].join('\n');

// A deliberately OX-less synthetic entry (silent-drop guard fixture).
const ENTRY_NO_OX = [
    'ID   FAKE3_UNKNW             Reviewed;          50 AA.',
    'AC   R00003;',
    'DE   RecName: Full=Fake organismless protein three;',
    'OS   synthetic construct.',
    'DR   EMBL; XX000000; -; -; Genomic_DNA.',
    'SQ   SEQUENCE    50 AA;   5000 MW;  AABBCCDDEEFF0011 CRC64;',
    '     MKTAYIAKQR QISFVKSHFS',
].join('\n');

const DAT = [ENTRY_HUMAN, '//', ENTRY_MOUSE, '//', ENTRY_NO_OX, '//', ''].join('\n');

describe('splitRecordBlocks (// delimiter)', () => {
    it('yields exactly one block per // delimiter; trailing partial -> remainder', () => {
        const { blocks, remainder } = splitRecordBlocks(DAT);
        expect(blocks.filter(isNonEmptyBlock)).toHaveLength(3);
        expect(remainder.trim()).toBe(''); // nothing after the last //
        expect(RECORD_DELIMITER).toBe('//');
    });

    it('carries an incomplete trailing record into remainder (no premature emit)', () => {
        const partial = ENTRY_HUMAN + '\n//\n' + 'ID   FAKE4_RAT';
        const { blocks, remainder } = splitRecordBlocks(partial);
        expect(blocks.filter(isNonEmptyBlock)).toHaveLength(1);
        expect(remainder).toContain('FAKE4_RAT'); // held, not emitted as a block
    });

    it('chunk-boundary join: remainder + next chunk reconstructs a split record', () => {
        const head = ENTRY_HUMAN.slice(0, 40);
        const tail = ENTRY_HUMAN.slice(40) + '\n//\n';
        const r1 = splitRecordBlocks(head);
        expect(r1.blocks.filter(isNonEmptyBlock)).toHaveLength(0);
        const r2 = splitRecordBlocks(r1.remainder + tail);
        expect(r2.blocks.filter(isNonEmptyBlock)).toHaveLength(1);
        expect(r2.blocks[0]).toContain('FAKE1_HUMAN');
    });
});

describe('extractFieldMapTentative (TENTATIVE, not the ingest parser)', () => {
    it('pulls the expected candidate token per line code', () => {
        const fm = extractFieldMapTentative(ENTRY_HUMAN);
        expect(fm).toEqual({
            id_len: 123,
            accession: 'Q00001',
            de_full: 'Fake human protein one',
            ec: '1.2.3.4',
            gene: 'FAKE1',
            organism: 'Homo sapiens (Human)',
            taxid: 9606,
            sq_len: 123,
            sq_mw: 13456,
        });
    });

    it('missing optional fields (no EC) -> null, never throws', () => {
        const fm = extractFieldMapTentative(ENTRY_MOUSE);
        expect(fm.ec).toBeNull();
        expect(fm.accession).toBe('P00002');
        expect(fm.taxid).toBe(10090);
        expect(fm.sq_len).toBe(88);
    });

    it('OX-less record -> taxid null (counted by the tally, not lost here)', () => {
        expect(extractFieldMapTentative(ENTRY_NO_OX).taxid).toBeNull();
    });
});

describe('parseTaxId', () => {
    it('extracts NCBI_TaxID with or without ECO evidence braces', () => {
        expect(parseTaxId('OX   NCBI_TaxID=9606 {ECO:0000312};')).toBe(9606);
        expect(parseTaxId('OX   NCBI_TaxID=10116;')).toBe(10116);
        expect(parseTaxId('NCBI_TaxID=10090')).toBe(10090);
    });
    it('no parseable taxid -> null (never throws on junk)', () => {
        expect(parseTaxId('OX   something else')).toBeNull();
        expect(parseTaxId(null)).toBeNull();
        expect(parseTaxId(undefined)).toBeNull();
    });
});

describe('tallyTaxon (9606/10090/10116 + no-OX silent-drop guard)', () => {
    it('tallies the 3 target taxa correctly', () => {
        const t = newTaxonTally();
        tallyTaxon(t, ENTRY_HUMAN);  // 9606
        tallyTaxon(t, ENTRY_MOUSE);  // 10090
        const rat = ENTRY_MOUSE.replace('NCBI_TaxID=10090', 'NCBI_TaxID=10116');
        tallyTaxon(t, rat);          // 10116
        expect(t[9606]).toBe(1);
        expect(t[10090]).toBe(1);
        expect(t[10116]).toBe(1);
        expect(t.other).toBe(0);
        expect(t.no_ox).toBe(0);
    });

    it('non-target taxid -> other; OX-less record -> no_ox (COUNTED, not dropped)', () => {
        const t = newTaxonTally();
        const yeast = ENTRY_MOUSE.replace('NCBI_TaxID=10090', 'NCBI_TaxID=559292');
        tallyTaxon(t, yeast);     // other
        tallyTaxon(t, ENTRY_NO_OX); // no_ox
        expect(t.other).toBe(1);
        expect(t.no_ox).toBe(1);
        expect(t[9606] + t[10090] + t[10116]).toBe(0);
    });

    it('TARGET_TAXA + REST baseline constants are the locked references', () => {
        expect(TARGET_TAXA).toEqual([9606, 10090, 10116]);
        expect(REST_TOTAL_BASELINE).toBe(574627);
    });
});

describe('tallyDrSources (xref-source distribution)', () => {
    it('counts the first ;-token of each DR line as the source type', () => {
        const dr = newDrSourceTally();
        tallyDrSources(dr, ENTRY_HUMAN); // PDB, AlphaFoldDB
        tallyDrSources(dr, ENTRY_MOUSE); // PDB
        tallyDrSources(dr, ENTRY_NO_OX); // EMBL
        expect(dr.get('PDB')).toBe(2);
        expect(dr.get('AlphaFoldDB')).toBe(1);
        expect(dr.get('EMBL')).toBe(1);
        const top = topDrSources(dr, 30);
        expect(top[0]).toEqual(['PDB', 2]); // descending by count
    });
});

describe('hasCcByLicense (CC BY 4.0 presence)', () => {
    it('PASS when the CC block names the Creative Commons Attribution (CC BY 4.0) license', () => {
        expect(hasCcByLicense(ENTRY_HUMAN)).toBe(true);
    });
    it('FAIL when no CC BY 4.0 notice is present', () => {
        expect(hasCcByLicense(ENTRY_MOUSE)).toBe(false);
        expect(hasCcByLicense(ENTRY_NO_OX)).toBe(false);
    });
});

describe('determinism (same input -> same counts)', () => {
    it('two independent passes over identical blocks yield identical tallies', () => {
        const run = () => {
            const { blocks } = splitRecordBlocks(DAT);
            const taxa = newTaxonTally();
            const dr = newDrSourceTally();
            let total = 0, cc = 0;
            for (const b of blocks) {
                if (!isNonEmptyBlock(b)) continue;
                total++;
                tallyTaxon(taxa, b);
                tallyDrSources(dr, b);
                if (hasCcByLicense(b)) cc++;
            }
            return { total, taxa, dr: [...dr.entries()].sort(), cc };
        };
        expect(run()).toEqual(run());
        const a = run();
        expect(a.total).toBe(3);
        expect(a.taxa[9606]).toBe(1);
        expect(a.taxa[10090]).toBe(1);
        expect(a.taxa.no_ox).toBe(1);
        expect(a.cc).toBe(1);
    });
});
