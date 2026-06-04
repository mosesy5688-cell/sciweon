// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { buildOtTargetMap, mergeBioactivityTargets } from '../../scripts/factory/lib/target-linker-helpers.js';

const NOW = '2026-05-24T12:00:00Z';

function otRecord(uniprotIds, overrides = {}) {
    return {
        ensembl_gene_id: 'ENSG00000146648',
        approved_symbol: 'EGFR',
        approved_name: 'Epidermal growth factor receptor',
        biotype: 'protein_coding',
        uniprot_canonical_ids: uniprotIds,
        uniprot_trembl_ids: [],
        target_class: [{ id: 100, label: 'Kinase', level: 'L1' }],
        db_xrefs: [{ id: 'HGNC:3236', source: 'HGNC' }],
        synonyms: ['HER1', 'ERBB1'],
        symbol_synonyms: ['HER1'],
        function_descriptions: ['Receptor tyrosine kinase.'],
        subcellular_locations: ['Cell membrane'],
        genomic_location: { chromosome: '7', start: 55019017, end: 55211628, strand: 1 },
        ...overrides,
    };
}

function bioRecord(uniprot, overrides = {}) {
    return {
        target: {
            uniprot_accession: uniprot,
            gene_symbol: 'EGFR',
            protein_name: 'EGFR',
            chembl_id: 'CHEMBL203',
            organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' },
        },
        ...overrides,
    };
}

describe('buildOtTargetMap — OT primary load', () => {
    it('canonical UniProt becomes one target entry', () => {
        const { targets, skippedNoUniprot } = buildOtTargetMap([otRecord(['P00533'])], NOW);
        expect(targets.size).toBe(1);
        expect(skippedNoUniprot).toBe(0);
        const t = targets.get('P00533');
        expect(t.uniprot_accession).toBe('P00533');
        expect(t.id).toBe('sciweon::target::uniprot:P00533');
        expect(t.ensembl_gene_id).toBe('ENSG00000146648');
        expect(t.approved_symbol).toBe('EGFR');
        expect(t.provenance.sources).toHaveLength(1);
        expect(t.provenance.sources[0].source).toBe('open_targets');
    });

    it('OT record without UniProt → skipped', () => {
        const { targets, skippedNoUniprot } = buildOtTargetMap([otRecord([])], NOW);
        expect(targets.size).toBe(0);
        expect(skippedNoUniprot).toBe(1);
    });

    it('OT record with multiple canonical UniProt IDs → multiple target entries', () => {
        const rec = otRecord(['P00533', 'Q9Y5N6']);
        const { targets } = buildOtTargetMap([rec], NOW);
        expect(targets.size).toBe(2);
        expect(targets.has('P00533')).toBe(true);
        expect(targets.has('Q9Y5N6')).toBe(true);
    });

    it('duplicate UniProt across two OT records → keeps first (deterministic)', () => {
        const r1 = otRecord(['P00533'], { approved_name: 'First name' });
        const r2 = otRecord(['P00533'], { approved_name: 'Second name' });
        const { targets } = buildOtTargetMap([r1, r2], NOW);
        expect(targets.size).toBe(1);
        expect(targets.get('P00533').approved_name).toBe('First name');
    });

    it('isoform suffix in OT input → truncation via sanitizeUniprot', () => {
        const { targets } = buildOtTargetMap([otRecord(['P00533-2'])], NOW);
        expect(targets.size).toBe(1);
        expect(targets.get('P00533')).toBeDefined();
    });

    it('organism is evidence-derived (null on OT load — PR-UNIPROT-2a removed the 9606 lie)', () => {
        const { targets } = buildOtTargetMap([otRecord(['P00533'])], NOW);
        const t = targets.get('P00533');
        // The hardcoded { taxon_id: 9606, scientific_name: 'Homo sapiens' } is GONE.
        // OT rows carry no organism evidence -> organism stays null until the UniProt
        // accession-join (PR-UNIPROT-2b) supplies the real, all-organism taxon.
        expect(t.organism).toBeNull();
    });
});

describe('mergeBioactivityTargets — secondary source merge', () => {
    it('bioactivity-only UniProt → adds skeleton target', () => {
        const targets = new Map();
        const stats = mergeBioactivityTargets(targets, [bioRecord('P00734')], NOW);
        expect(targets.size).toBe(1);
        expect(stats.added).toBe(1);
        expect(stats.appendedToExisting).toBe(0);
        const t = targets.get('P00734');
        expect(t.uniprot_accession).toBe('P00734');
        expect(t.provenance.sources[0].source).toBe('chembl_bioactivity');
        expect(t.ensembl_gene_id).toBeNull();
    });

    it('bioactivity UniProt matching existing OT target → appends chembl_bioactivity provenance source', () => {
        const { targets } = buildOtTargetMap([otRecord(['P00533'])], NOW);
        const stats = mergeBioactivityTargets(targets, [bioRecord('P00533')], NOW);
        expect(stats.added).toBe(0);
        expect(stats.appendedToExisting).toBe(1);
        const t = targets.get('P00533');
        expect(t.provenance.sources).toHaveLength(2);
        expect(t.provenance.sources.map(s => s.source)).toEqual(['open_targets', 'chembl_bioactivity']);
        // OT metadata wins — approved_symbol stays EGFR, NOT overwritten
        expect(t.approved_symbol).toBe('EGFR');
    });

    it('multiple bioactivity records for same UniProt → provenance appended only once', () => {
        const { targets } = buildOtTargetMap([otRecord(['P00533'])], NOW);
        const stats = mergeBioactivityTargets(targets, [bioRecord('P00533'), bioRecord('P00533')], NOW);
        expect(stats.appendedToExisting).toBe(1);
        expect(targets.get('P00533').provenance.sources).toHaveLength(2);
    });

    it('bioactivity without target.uniprot_accession → skipped', () => {
        const targets = new Map();
        const stats = mergeBioactivityTargets(targets, [{ target: {} }, { target: null }, {}], NOW);
        expect(stats.skippedNoUniprot).toBe(3);
        expect(stats.added).toBe(0);
        expect(targets.size).toBe(0);
    });

    it('isoform UniProt in bioactivity → truncated then merged', () => {
        const targets = new Map();
        mergeBioactivityTargets(targets, [bioRecord('P00734-2')], NOW);
        expect(targets.has('P00734')).toBe(true);
    });

    it('mixed (OT + bioactivity-only + bioactivity-matching) → correct partition', () => {
        const { targets } = buildOtTargetMap([otRecord(['P00533']), otRecord(['Q9Y5N6'], { ensembl_gene_id: 'ENSG00000200000', approved_symbol: 'XX' })], NOW);
        const stats = mergeBioactivityTargets(targets, [
            bioRecord('P00533'),      // matches OT
            bioRecord('P00734'),      // new (bioactivity-only)
            bioRecord('P00734'),      // dup of above (no double-add)
        ], NOW);
        expect(targets.size).toBe(3);
        expect(stats.added).toBe(1);
        expect(stats.appendedToExisting).toBe(1);
        expect(targets.get('P00734').provenance.sources).toHaveLength(1);
        expect(targets.get('P00734').provenance.sources[0].source).toBe('chembl_bioactivity');
    });

    it('bioactivity skeleton uses bioactivity organism + chembl_id + protein/gene names', () => {
        const targets = new Map();
        const bio = bioRecord('P00734', { target: { uniprot_accession: 'P00734', gene_symbol: 'F2', protein_name: 'Prothrombin', chembl_id: 'CHEMBL204', organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' } } });
        mergeBioactivityTargets(targets, [bio], NOW);
        const t = targets.get('P00734');
        expect(t.approved_symbol).toBe('F2');
        expect(t.approved_name).toBe('Prothrombin');
        expect(t.provenance.sources[0].source_id).toBe('CHEMBL204');
        expect(t.organism.scientific_name).toBe('Homo sapiens');
    });
});

describe('dedup invariants', () => {
    it('byte-stable rerun: same OT input produces same target Map size', () => {
        const ot = [otRecord(['P00533']), otRecord(['Q9Y5N6'], { ensembl_gene_id: 'ENSG2' })];
        const r1 = buildOtTargetMap(ot, NOW);
        const r2 = buildOtTargetMap(ot, NOW);
        expect(r1.targets.size).toBe(r2.targets.size);
    });

    it('OT primary then bioactivity merge: total = OT unique + bioactivity-only', () => {
        const { targets } = buildOtTargetMap([otRecord(['P00533'])], NOW);
        mergeBioactivityTargets(targets, [bioRecord('P00533'), bioRecord('P00734')], NOW);
        expect(targets.size).toBe(2);
    });
});
