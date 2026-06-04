// @ts-nocheck
/**
 * PR-UNIPROT-1: pure UniProt SwissProt .dat parser contract tests.
 *
 * SYNTHETIC .dat record blocks ONLY (fabricated, real EMBL/SwissProt line codes,
 * NO real UniProt content). Locks parseUniprotRecord's full field extraction +
 * FULL-corpus / FULL-record guarantees (no organism filter, no DR whitelist) +
 * the // splitter remainder-carry across a chunk boundary + determinism (byte-
 * identical output + sorted inner arrays) + the no-silent-drop edges
 * (no GN -> null gene, no FUNCTION -> [], no OX -> COUNTED not dropped).
 *
 * Mirrors the streaming-resilience expectation: the orchestrator reuses
 * stream-fetch-retry.js (covered by stream-fetch-retry.test.ts); this file
 * unit-tests the PURE parser that the streaming consumer wires.
 */

import { describe, it, expect } from 'vitest';
import {
    splitRecordBlocks, isNonEmptyBlock, parseUniprotRecord, recordToJsonl,
    newTaxonTally, tallyTaxon, RECORD_DELIMITER, UNIPROT_LICENSE,
} from '../../scripts/factory/lib/uniprot-dat-stream.js';
import { validateUniprotBulkRecord } from '../../src/lib/schemas/uniprot-bulk.js';

// A complete synthetic SwissProt record block (delimiter excluded). Multi-AC,
// RecName Full + EC, GN Name, OS + OX, SQ len+MW, CC FUNCTION, several DR sources.
const FULL_HUMAN = [
    'ID   FAKE1_HUMAN             Reviewed;         350 AA.',
    'AC   P12345; Q67890; A0A001;',
    'AC   B2BBB2;',
    'DE   RecName: Full=Fake enzyme alpha;',
    'DE            EC=1.2.3.4;',
    'DE   AltName: Full=Some other name;',
    'GN   Name=FAKE1; Synonyms=FK1;',
    'OS   Homo sapiens (Human).',
    'OX   NCBI_TaxID=9606 {ECO:0000313};',
    'CC   -!- FUNCTION: Catalyzes a fake reaction. Involved in the fake',
    'CC       pathway and binds a fake cofactor.',
    'CC   -!- SUBUNIT: Homodimer.',
    'DR   PDB; 1ABC; X-ray; 2.00 A; A=1-350.',
    'DR   GO; GO:0005524; F:ATP binding; IEA:UniProtKB.',
    'DR   Ensembl; ENST00000123456; ENSP00000123456; ENSG00000123456.',
    'DR   AlphaFoldDB; P12345; -.',
    'SQ   SEQUENCE   350 AA;  39000 MW;  ABCDEF0123456789 CRC64;',
    '     MKLVFAGTHE QWERTYUIOP ASDFGHJKLZ',
].join('\n');

describe('splitRecordBlocks (remainder-carry across a chunk boundary)', () => {
    it('splits on a // line and emits complete blocks; trailing half -> remainder', () => {
        const text = `ID   A\nAC   P00001;\n${RECORD_DELIMITER}\nID   B\nAC   P00002;\n${RECORD_DELIMITER}\nID   C\nAC   P000`;
        const { blocks, remainder } = splitRecordBlocks(text);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toContain('AC   P00001;');
        expect(blocks[1]).toContain('AC   P00002;');
        expect(remainder).toBe('ID   C\nAC   P000'); // the incomplete 3rd record carries
    });

    it('a record SPANNING two chunks parses identically once the remainder is carried', () => {
        const chunk1 = FULL_HUMAN.slice(0, 120); // cut mid-record
        const chunk2 = FULL_HUMAN.slice(120) + `\n${RECORD_DELIMITER}\n`;
        // chunk 1 alone yields no complete block; its text is held as remainder.
        const r1 = splitRecordBlocks(chunk1);
        expect(r1.blocks).toHaveLength(0);
        // carrying the remainder into chunk 2 yields exactly one complete block.
        const r2 = splitRecordBlocks(r1.remainder + chunk2);
        expect(r2.blocks).toHaveLength(1);
        const rec = parseUniprotRecord(r2.blocks[0]);
        expect(rec.accession).toBe('P12345');
        expect(rec.gene_symbol).toBe('FAKE1');
    });

    it('isNonEmptyBlock rejects blank / delimiter-only blocks', () => {
        expect(isNonEmptyBlock('')).toBe(false);
        expect(isNonEmptyBlock('   \n  ')).toBe(false);
        expect(isNonEmptyBlock('ID   A')).toBe(true);
    });
});

describe('parseUniprotRecord -- full field extraction', () => {
    const rec = parseUniprotRecord(FULL_HUMAN);

    it('multi-AC -> primary + sorted secondary accessions', () => {
        expect(rec.accession).toBe('P12345');
        expect(rec.secondary_accessions).toEqual(['A0A001', 'B2BBB2', 'Q67890']); // sorted lexically
    });

    it('DE RecName Full -> recommended_name; EC -> ec_numbers[]', () => {
        expect(rec.recommended_name).toBe('Fake enzyme alpha');
        expect(rec.ec_numbers).toEqual(['1.2.3.4']);
    });

    it('GN Name -> gene_symbol', () => {
        expect(rec.gene_symbol).toBe('FAKE1');
    });

    it('OS + OX -> organism {scientific_name, taxon_id}', () => {
        expect(rec.organism.scientific_name).toBe('Homo sapiens (Human)');
        expect(rec.organism.taxon_id).toBe(9606);
    });

    it('SQ -> sequence_length + sequence_mol_weight', () => {
        expect(rec.sequence_length).toBe(350);
        expect(rec.sequence_mol_weight).toBe(39000);
    });

    it('CC FUNCTION -> function_descriptions[] (continuation joined; SUBUNIT excluded)', () => {
        expect(rec.function_descriptions).toHaveLength(1);
        expect(rec.function_descriptions[0]).toBe(
            'Catalyzes a fake reaction. Involved in the fake pathway and binds a fake cofactor.',
        );
        expect(rec.function_descriptions[0]).not.toContain('Homodimer');
    });

    it('ALL DR sources captured (no whitelist, no cap) + sorted by (source,id)', () => {
        expect(rec.db_xrefs).toEqual([
            { source: 'AlphaFoldDB', id: 'P12345' },
            { source: 'Ensembl', id: 'ENST00000123456' },
            { source: 'GO', id: 'GO:0005524' },
            { source: 'PDB', id: '1ABC' },
        ]);
        // _meta carries no dr_capped field (PR-UNIPROT-1b removed the DR cap).
        expect(rec._meta.dr_capped).toBeUndefined();
    });

    it('license stamped cc-by-4.0', () => {
        expect(rec.license).toBe(UNIPROT_LICENSE);
        expect(rec.license).toBe('cc-by-4.0');
    });

    it('passes the bulk artifact-record validator', () => {
        const { valid, errors } = validateUniprotBulkRecord(JSON.parse(recordToJsonl(rec)));
        expect(errors).toEqual([]);
        expect(valid).toBe(true);
    });
});

describe('parseUniprotRecord -- no-silent-drop edges', () => {
    it('NO GN line -> gene_symbol null (record kept, not dropped)', () => {
        const block = [
            'ID   NOGENE_VIRUS            Reviewed;         120 AA.',
            'AC   Q11111;',
            'DE   RecName: Full=Viral capsid protein;',
            'OS   Fake virus 1.',
            'OX   NCBI_TaxID=333333;',
            'SQ   SEQUENCE   120 AA;  13000 MW;  X CRC64;',
        ].join('\n');
        const rec = parseUniprotRecord(block);
        expect(rec.gene_symbol).toBeNull();
        expect(rec.accession).toBe('Q11111');
    });

    it('NO FUNCTION CC -> function_descriptions empty array (not null, not dropped)', () => {
        const block = [
            'ID   NOFUNC_HUMAN            Reviewed;         90 AA.',
            'AC   P22222;',
            'DE   RecName: Full=Uncharacterized protein;',
            'OS   Homo sapiens (Human).',
            'OX   NCBI_TaxID=9606;',
            'SQ   SEQUENCE   90 AA;  10000 MW;  X CRC64;',
        ].join('\n');
        const rec = parseUniprotRecord(block);
        expect(rec.function_descriptions).toEqual([]);
    });

    it('NO OX -> taxon_id null + _meta.no_ox true (COUNTED, never silently dropped)', () => {
        const block = [
            'ID   NOOX_UNKNOWN            Reviewed;         60 AA.',
            'AC   P33333;',
            'DE   RecName: Full=Mystery protein;',
            'OS   unidentified organism.',
            'SQ   SEQUENCE   60 AA;  7000 MW;  X CRC64;',
        ].join('\n');
        const rec = parseUniprotRecord(block);
        expect(rec.organism.taxon_id).toBeNull();
        expect(rec._meta.no_ox).toBe(true);
        expect(rec.accession).toBe('P33333'); // still a valid kept record
    });

    it('a record with NO AC primary accession HARD-THROWS (orchestrator fatal-fails)', () => {
        const block = [
            'ID   BROKEN_NOAC            Reviewed;         10 AA.',
            'DE   RecName: Full=Broken;',
            'OX   NCBI_TaxID=9606;',
        ].join('\n');
        expect(() => parseUniprotRecord(block)).toThrow(/no AC primary accession/);
    });
});

describe('parseUniprotRecord -- FULL corpus (no organism filter)', () => {
    it('a NON-human record is KEPT (the preserve-all-source-data ruling)', () => {
        const block = [
            'ID   MOUSE1_MOUSE            Reviewed;         200 AA.',
            'AC   P44444;',
            'DE   RecName: Full=Mouse fake protein;',
            'GN   Name=Fk1;',
            'OS   Mus musculus (Mouse).',
            'OX   NCBI_TaxID=10090;',
            'DR   MGI; MGI:12345; Fk1.',
            'SQ   SEQUENCE   200 AA;  22000 MW;  X CRC64;',
        ].join('\n');
        const rec = parseUniprotRecord(block);
        expect(rec.organism.taxon_id).toBe(10090); // mouse kept, not filtered
        expect(rec.db_xrefs).toEqual([{ source: 'MGI', id: 'MGI:12345' }]);
    });

    it('tallyTaxon counts each taxon (telemetry, never a filter); no_ox bucketed', () => {
        const tally = newTaxonTally();
        tallyTaxon(tally, { organism: { taxon_id: 9606 } });
        tallyTaxon(tally, { organism: { taxon_id: 10090 } });
        tallyTaxon(tally, { organism: { taxon_id: 9606 } });
        tallyTaxon(tally, { organism: { taxon_id: null } });
        expect(tally.get(9606)).toBe(2);
        expect(tally.get(10090)).toBe(1);
        expect(tally.get('no_ox')).toBe(1);
    });
});

describe('parseUniprotRecord -- determinism (byte-identical)', () => {
    it('same input -> byte-identical serialized record', () => {
        const a = recordToJsonl(parseUniprotRecord(FULL_HUMAN));
        const b = recordToJsonl(parseUniprotRecord(FULL_HUMAN));
        expect(a).toBe(b);
    });

    it('inner arrays are sorted regardless of source line order (db_xrefs, ec, secondary)', () => {
        const shuffled = [
            'ID   X_HUMAN                 Reviewed;         50 AA.',
            'AC   P55555; Z9ZZZ9; A1AAA1;',
            'DE   RecName: Full=Multi EC enzyme;',
            'DE            EC=9.9.9.9;',
            'DE            EC=1.1.1.1;',
            'OS   Homo sapiens (Human).',
            'OX   NCBI_TaxID=9606;',
            'DR   Zoo; z1; -.',
            'DR   Alpha; a1; -.',
            'SQ   SEQUENCE   50 AA;  5000 MW;  X CRC64;',
        ].join('\n');
        const rec = parseUniprotRecord(shuffled);
        expect(rec.secondary_accessions).toEqual(['A1AAA1', 'Z9ZZZ9']);
        expect(rec.ec_numbers).toEqual(['1.1.1.1', '9.9.9.9']);
        expect(rec.db_xrefs).toEqual([
            { source: 'Alpha', id: 'a1' },
            { source: 'Zoo', id: 'z1' },
        ]);
    });
});

