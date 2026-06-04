// @ts-nocheck
/**
 * PR-UNIPROT-1: UniProt bulk artifact-record schema/validator + DR-cap contract.
 *
 * Split from uniprot-dat-stream.test.ts (Art 5.1 250-line cap). Locks the
 * validateUniprotBulkRecord gate (the artifact-record schema, SEPARATE from
 * target.js -- the target merge is PR-UNIPROT-2) + the per-record DR_XREF_CAP
 * pathological-record bound (counted in _meta.dr_capped, never silently dropped).
 *
 * SYNTHETIC blocks only (real line codes, NO real UniProt content).
 */

import { describe, it, expect } from 'vitest';
import {
    parseUniprotRecord, recordToJsonl, DR_XREF_CAP,
} from '../../scripts/factory/lib/uniprot-dat-stream.js';
import {
    validateUniprotBulkRecord, UNIPROT_ACCESSION_PATTERN, UNIPROT_BULK_LICENSE,
} from '../../src/lib/schemas/uniprot-bulk.js';

const VALID_BLOCK = [
    'ID   FAKE1_HUMAN             Reviewed;         350 AA.',
    'AC   P12345; Q67890;',
    'DE   RecName: Full=Fake enzyme alpha;',
    'OS   Homo sapiens (Human).',
    'OX   NCBI_TaxID=9606;',
    'DR   PDB; 1ABC; X-ray.',
    'SQ   SEQUENCE   350 AA;  39000 MW;  X CRC64;',
].join('\n');

describe('DR per-record cap (pathological-record bound; counted not dropped)', () => {
    it('caps db_xrefs at DR_XREF_CAP and counts the overflow in _meta.dr_capped', () => {
        const drLines = [];
        for (let i = 0; i < DR_XREF_CAP + 5; i++) {
            drLines.push(`DR   Src${String(i).padStart(6, '0')}; id${i}; -.`);
        }
        const block = [
            'ID   BIG_HUMAN               Reviewed;         10 AA.',
            'AC   P66666;',
            'DE   RecName: Full=Pathological xref record;',
            'OS   Homo sapiens (Human).',
            'OX   NCBI_TaxID=9606;',
            ...drLines,
            'SQ   SEQUENCE   10 AA;  1000 MW;  X CRC64;',
        ].join('\n');
        const rec = parseUniprotRecord(block);
        expect(rec.db_xrefs.length).toBe(DR_XREF_CAP);
        expect(rec._meta.dr_capped).toBe(5);
    });
});

describe('validateUniprotBulkRecord + accession pattern', () => {
    it('accepts a well-formed parsed record', () => {
        const { valid, errors } = validateUniprotBulkRecord(JSON.parse(recordToJsonl(parseUniprotRecord(VALID_BLOCK))));
        expect(errors).toEqual([]);
        expect(valid).toBe(true);
    });

    it('rejects a record with a malformed accession', () => {
        const bad = JSON.parse(recordToJsonl(parseUniprotRecord(VALID_BLOCK)));
        bad.accession = 'not-an-accession';
        const { valid, errors } = validateUniprotBulkRecord(bad);
        expect(valid).toBe(false);
        expect(errors.join(' ')).toContain('accession invalid');
    });

    it('rejects a record whose license is not cc-by-4.0', () => {
        const bad = JSON.parse(recordToJsonl(parseUniprotRecord(VALID_BLOCK)));
        bad.license = 'cc0-1.0';
        const { valid } = validateUniprotBulkRecord(bad);
        expect(valid).toBe(false);
    });

    it('allows organism.taxon_id null (the no_ox edge -- kept, not rejected)', () => {
        const rec = JSON.parse(recordToJsonl(parseUniprotRecord(VALID_BLOCK)));
        rec.organism.taxon_id = null;
        const { valid } = validateUniprotBulkRecord(rec);
        expect(valid).toBe(true);
    });

    it('accepts the canonical 6-char and 10-char UniProt accession forms', () => {
        expect(UNIPROT_ACCESSION_PATTERN.test('P12345')).toBe(true);
        expect(UNIPROT_ACCESSION_PATTERN.test('A0A001')).toBe(true);
        expect(UNIPROT_ACCESSION_PATTERN.test('lowercase')).toBe(false);
        expect(UNIPROT_BULK_LICENSE).toBe('cc-by-4.0');
    });
});
