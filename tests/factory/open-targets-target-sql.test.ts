// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    sanitizeUniprot, dedupeUniprot, assertBiotypeProteinCoding,
    openTargetsTargetRowToSciweonRecord, buildTargetCursorRecord,
} from '../../scripts/factory/lib/open-targets-target-sql.js';

const NOW = '2026-05-24T12:00:00Z';
const TODAY = '2026-05-24';

const SAMPLE_ROW = {
    ensembl_gene_id: 'ENSG00000146648',
    approved_symbol: 'EGFR',
    approved_name: 'Epidermal growth factor receptor',
    biotype: 'protein_coding',
    uniprot_swissprot_ids: ['P00533'],
    uniprot_trembl_ids: [],
    db_xrefs: [
        { id: 'HGNC:3236', source: 'HGNC' },
        { id: '1956', source: 'NCBI Gene' },
    ],
    target_class: [
        { id: 100, label: 'Enzyme', level: 'L1' },
        { id: 200, label: 'Kinase', level: 'L2' },
    ],
    synonyms: ['HER1', 'ERBB1'],
    symbol_synonyms: ['HER1'],
    function_descriptions: ['Receptor tyrosine kinase.'],
    subcellular_locations: ['Cell membrane'],
    genomic_location: { chromosome: '7', start: 55019017, end: 55211628, strand: 1 },
};

describe('sanitizeUniprot — defect-8 truncation roll-up', () => {
    it('canonical accession unchanged', () => {
        expect(sanitizeUniprot('P00533')).toBe('P00533');
    });
    it('isoform -2 truncated to canonical', () => {
        expect(sanitizeUniprot('P00533-2')).toBe('P00533');
    });
    it('isoform -3 truncated', () => {
        expect(sanitizeUniprot('Q9Y5N6-3')).toBe('Q9Y5N6');
    });
    it('multi-digit isoform truncated', () => {
        expect(sanitizeUniprot('P12345-12')).toBe('P12345');
    });
    it('lowercase normalized to uppercase', () => {
        expect(sanitizeUniprot('p00533')).toBe('P00533');
    });
    it('whitespace trimmed', () => {
        expect(sanitizeUniprot('  P00533  ')).toBe('P00533');
    });
    it('non-string returns null', () => {
        expect(sanitizeUniprot(null)).toBeNull();
        expect(sanitizeUniprot(undefined)).toBeNull();
        expect(sanitizeUniprot(42)).toBeNull();
    });
    it('empty string returns null', () => {
        expect(sanitizeUniprot('')).toBeNull();
        expect(sanitizeUniprot('   ')).toBeNull();
    });
});

describe('dedupeUniprot', () => {
    it('removes duplicates after isoform truncation', () => {
        const r = dedupeUniprot(['P00533', 'P00533-2', 'P00533-3']);
        expect(r).toEqual(['P00533']);
    });
    it('preserves distinct accessions, order stable', () => {
        const r = dedupeUniprot(['P00533', 'Q9Y5N6', 'P00533-2']);
        expect(r).toEqual(['P00533', 'Q9Y5N6']);
    });
    it('non-array input returns empty', () => {
        expect(dedupeUniprot(null)).toEqual([]);
        expect(dedupeUniprot(undefined)).toEqual([]);
        expect(dedupeUniprot('string')).toEqual([]);
    });
    it('empty array yields empty result', () => {
        expect(dedupeUniprot([])).toEqual([]);
    });
    it('drops invalid entries (null/empty)', () => {
        expect(dedupeUniprot([null, '', 'P00533', '   '])).toEqual(['P00533']);
    });
});

describe('assertBiotypeProteinCoding — defect-9 Layer 2 defense', () => {
    it('accepts protein_coding', () => {
        expect(() => assertBiotypeProteinCoding('protein_coding')).not.toThrow();
    });
    it('throws on lncRNA', () => {
        expect(() => assertBiotypeProteinCoding('lncRNA')).toThrow(/biotype/);
    });
    it('throws on rna_pseudogene', () => {
        expect(() => assertBiotypeProteinCoding('rna_pseudogene')).toThrow(/biotype/);
    });
    it('throws on undefined', () => {
        expect(() => assertBiotypeProteinCoding(undefined)).toThrow(/biotype/);
    });
});

describe('openTargetsTargetRowToSciweonRecord — full transform', () => {
    it('produces canonical OT-target bulk record', () => {
        const r = openTargetsTargetRowToSciweonRecord(SAMPLE_ROW, '26.03', TODAY);
        expect(r.id).toBe('sciweon::ot-target::ENSG00000146648');
        expect(r.ensembl_gene_id).toBe('ENSG00000146648');
        expect(r.approved_symbol).toBe('EGFR');
        expect(r.approved_name).toBe('Epidermal growth factor receptor');
        expect(r.biotype).toBe('protein_coding');
        expect(r.uniprot_canonical_ids).toEqual(['P00533']);
        expect(r.uniprot_trembl_ids).toEqual([]);
        expect(r.db_xrefs).toHaveLength(2);
        expect(r.target_class).toHaveLength(2);
        expect(r.synonyms).toEqual(['HER1', 'ERBB1']);
        expect(r.genomic_location.chromosome).toBe('7');
        expect(r.license_metadata.upstream_source).toBe('open_targets');
        expect(r.license_metadata.upstream_license).toBe('cc0-1.0');
        expect(r.license_metadata.upstream_release).toBe('26.03');
        expect(r.license_metadata.ingestion_date).toBe(TODAY);
    });

    it('isoform truncation applied to UniProt arrays', () => {
        const row = { ...SAMPLE_ROW, uniprot_swissprot_ids: ['P00533-2', 'P00533'] };
        const r = openTargetsTargetRowToSciweonRecord(row, '26.03', TODAY);
        expect(r.uniprot_canonical_ids).toEqual(['P00533']);
    });

    it('throws on missing ensembl_gene_id', () => {
        expect(() => openTargetsTargetRowToSciweonRecord({ ...SAMPLE_ROW, ensembl_gene_id: '' }, '26.03', TODAY))
            .toThrow(/ensembl_gene_id/);
    });

    it('throws on non-protein-coding biotype (defect-9 Layer 2)', () => {
        expect(() => openTargetsTargetRowToSciweonRecord({ ...SAMPLE_ROW, biotype: 'lncRNA' }, '26.03', TODAY))
            .toThrow(/biotype/);
    });

    it('null-tolerant on optional fields', () => {
        const row = {
            ensembl_gene_id: 'ENSG00000000457',
            biotype: 'protein_coding',
            uniprot_swissprot_ids: null,
            uniprot_trembl_ids: undefined,
        };
        const r = openTargetsTargetRowToSciweonRecord(row, '26.03', TODAY);
        expect(r.uniprot_canonical_ids).toEqual([]);
        expect(r.uniprot_trembl_ids).toEqual([]);
        expect(r.approved_symbol).toBeNull();
        expect(r.approved_name).toBeNull();
        expect(r.db_xrefs).toEqual([]);
        expect(r.target_class).toEqual([]);
        expect(r.genomic_location).toBeNull();
    });

    it('db_xrefs filters malformed entries', () => {
        const row = {
            ...SAMPLE_ROW,
            db_xrefs: [
                { id: 'HGNC:3236', source: 'HGNC' },
                { id: null, source: 'NCBI Gene' },     // bad id
                { id: '1956', source: null },            // bad source
                { id: '1956', source: 'NCBI Gene' },     // valid
            ],
        };
        const r = openTargetsTargetRowToSciweonRecord(row, '26.03', TODAY);
        expect(r.db_xrefs).toHaveLength(2);
        expect(r.db_xrefs.map(x => x.id)).toEqual(['HGNC:3236', '1956']);
    });

    it('target_class normalized correctly', () => {
        const row = { ...SAMPLE_ROW, target_class: [{ id: 100, label: 'Kinase' }, { label: 'Enzyme', level: 'L1' }] };
        const r = openTargetsTargetRowToSciweonRecord(row, '26.03', TODAY);
        expect(r.target_class[0]).toEqual({ id: 100, label: 'Kinase', level: null });
        expect(r.target_class[1]).toEqual({ id: null, label: 'Enzyme', level: 'L1' });
    });

    it('synonyms/symbol_synonyms/function_descriptions filter non-strings', () => {
        const row = { ...SAMPLE_ROW, synonyms: ['HER1', null, 42, 'ERBB1'] };
        const r = openTargetsTargetRowToSciweonRecord(row, '26.03', TODAY);
        expect(r.synonyms).toEqual(['HER1', 'ERBB1']);
    });
});

describe('buildTargetCursorRecord', () => {
    it('produces canonical cursor JSON shape', () => {
        const c = buildTargetCursorRecord({
            release: '26.03', recordCount: 7872,
            byteSizeUncompressed: 8400000, byteSizeCompressed: 1500000,
            ingestedAt: NOW,
        });
        expect(c.source).toBe('open_targets');
        expect(c.entity_class_hint).toBe('target');
        expect(c.release_version).toBe('26.03');
        expect(c.last_success_at).toBe(NOW);
        expect(c.record_count).toBe(7872);
        expect(c.byte_size_uncompressed).toBe(8400000);
        expect(c.byte_size_compressed).toBe(1500000);
        expect(c.r2_key).toBe('processed/bulk/open-targets/26.03/target-enriched.jsonl.zst');
        expect(c.schema_version).toBe('pr-sid-1.4-pre.1a');
    });
});
