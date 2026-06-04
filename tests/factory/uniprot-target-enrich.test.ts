// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
    buildTargetAccessionSet, uniprotRecordHitsTargets, buildUniprotAccessionIndex,
    enrichTargetsWithUniprot, mergeUniprotIntoTarget,
} from '../../scripts/factory/lib/uniprot-target-enrich-helpers.js';

const NOW = '2026-06-04T12:00:00Z';
const RELEASE = '2026_01';
const OPTS = { nowIso: NOW, release: RELEASE };

// A target as produced by target-linker (post PR-UNIPROT-2a: organism null on OT load).
function target(acc, overrides = {}) {
    return {
        id: `sciweon::target::uniprot:${acc}`,
        uniprot_accession: acc,
        ensembl_gene_id: 'ENSG00000146648',
        approved_symbol: null, approved_name: null, biotype: 'protein_coding',
        uniprot_trembl_ids: [], target_class: [], db_xrefs: [],
        synonyms: [], symbol_synonyms: [], function_descriptions: [],
        subcellular_locations: [], genomic_location: null, organism: null,
        provenance: {
            sources: [{ source: 'open_targets', source_id: 'ENSG00000146648', timestamp: NOW }],
            last_updated: NOW,
        },
        ...overrides,
    };
}

// A UniProt SwissProt bulk record (per lib/uniprot-dat-stream.js recordToJsonl shape).
function uniRec(accession, overrides = {}) {
    return {
        accession, secondary_accessions: [],
        recommended_name: 'Epidermal growth factor receptor',
        ec_numbers: ['2.7.10.1'], gene_symbol: 'EGFR',
        organism: { scientific_name: 'Homo sapiens', taxon_id: 9606 },
        sequence_length: 1210, sequence_mol_weight: 134277,
        function_descriptions: ['Receptor tyrosine kinase.'],
        db_xrefs: [{ source: 'HGNC', id: 'HGNC:3236' }], license: 'cc-by-4.0',
        ...overrides,
    };
}

const idxOf = (recs) => buildUniprotAccessionIndex(recs).index;

describe('buildTargetAccessionSet', () => {
    it('sanitizes (isoform strip + uppercase) and dedupes target accessions', () => {
        const set = buildTargetAccessionSet([target('P00533-2'), target('p00533'), target('Q9Y5N6')]);
        expect(set.has('P00533')).toBe(true);
        expect(set.has('Q9Y5N6')).toBe(true);
        expect(set.size).toBe(2);
    });
    it('skips targets with no accession', () => {
        const set = buildTargetAccessionSet([target('P00533'), { uniprot_accession: null }, {}]);
        expect(set.size).toBe(1);
    });
});

describe('uniprotRecordHitsTargets — streaming-side retain predicate', () => {
    const set = new Set(['P00533', 'Q12345']);
    it('retains on primary accession hit', () => {
        expect(uniprotRecordHitsTargets(uniRec('P00533'), set)).toBe(true);
    });
    it('retains on a SECONDARY accession hit (primary not in set)', () => {
        expect(uniprotRecordHitsTargets(uniRec('P99999', { secondary_accessions: ['Q12345'] }), set)).toBe(true);
    });
    it('drops a record hitting no target (unmatched_uniprot counter, no throw)', () => {
        expect(uniprotRecordHitsTargets(uniRec('P88888'), set)).toBe(false);
    });
});

describe('all-organism survives the join (NO scope-cut)', () => {
    it('mouse (taxon 10090) joins -> target.organism.taxon_id === 10090', () => {
        const t = target('P00533');
        enrichTargetsWithUniprot([t], idxOf([uniRec('P00533', { organism: { scientific_name: 'Mus musculus', taxon_id: 10090 } })]), OPTS);
        expect(t.organism.taxon_id).toBe(10090);
        expect(t.organism.scientific_name).toBe('Mus musculus');
    });
    it('a taxon_id:null record still matches (no drop) and sets organism', () => {
        const t = target('P00533');
        const { stats } = enrichTargetsWithUniprot([t], idxOf([uniRec('P00533', { organism: { scientific_name: null, taxon_id: null } })]), OPTS);
        expect(stats.matched).toBe(1);
        expect(t.organism).toEqual({ scientific_name: null, taxon_id: null });
        expect(stats.targets_with_null_organism_after_join).toBe(1);
    });
});

describe('SECONDARY-accession match', () => {
    it('target keyed on Q12345 joins record whose secondary is Q12345; source_id === primary P99999', () => {
        const t = target('Q12345');
        const { stats } = enrichTargetsWithUniprot([t], idxOf([uniRec('P99999', { secondary_accessions: ['Q12345'] })]), OPTS);
        expect(stats.matched).toBe(1);
        expect(t.provenance.sources.find(s => s.source === 'uniprot_swissprot').source_id).toBe('P99999');
        expect(t.uniprot_secondary_accessions).toEqual(['Q12345']);
    });
});

describe('NO-SILENT-DROP counters', () => {
    it('target with absent accession -> unmatched_target++, target retained un-enriched', () => {
        const t = { ...target('P00533'), uniprot_accession: null };
        const { targets, stats } = enrichTargetsWithUniprot([t], idxOf([uniRec('P00533')]), OPTS);
        expect(stats.matched).toBe(0);
        expect(stats.unmatched_target).toBe(1);
        expect(targets[0].provenance.sources.some(s => s.source === 'uniprot_swissprot')).toBe(false);
    });
    it('uniRec matching no target -> no throw; matched+unmatched===length', () => {
        const ts = [target('P00533'), { ...target('P11111') }];
        const { stats } = enrichTargetsWithUniprot(ts, idxOf([uniRec('P00533'), uniRec('P88888')]), OPTS);
        expect(stats.matched + stats.unmatched_target).toBe(ts.length);
        expect(stats.matched).toBe(1);
        expect(stats.unmatched_target).toBe(1);
    });
});

describe('COLLISION determinism', () => {
    it('primary wins over secondary-only; multi_accession_collision++ (order-independent)', () => {
        const primaryRec = uniRec('P00533');
        const secondaryRec = uniRec('P77777', { secondary_accessions: ['P00533'] });
        const a = buildUniprotAccessionIndex([primaryRec, secondaryRec]);
        const b = buildUniprotAccessionIndex([secondaryRec, primaryRec]);
        expect(a.multi_accession_collision).toBe(1);
        expect(b.multi_accession_collision).toBe(1);
        expect(a.index.get('P00533').accession).toBe('P00533');
        expect(b.index.get('P00533').accession).toBe('P00533');
    });
    it('two primaries claim same accession via secondary -> lexically-smaller primary wins', () => {
        const recZ = uniRec('Z00001', { secondary_accessions: ['Q55555'] });
        const recA = uniRec('A00001', { secondary_accessions: ['Q55555'] });
        expect(buildUniprotAccessionIndex([recZ, recA]).index.get('Q55555').accession).toBe('A00001');
        expect(buildUniprotAccessionIndex([recA, recZ]).index.get('Q55555').accession).toBe('A00001');
    });
});

describe('DETERMINISM — byte-stable', () => {
    const richRec = () => uniRec('P00533', {
        ec_numbers: ['3.1.1.1', '2.7.10.1'],
        secondary_accessions: ['Q99999', 'B00001'],
        db_xrefs: [{ source: 'PDB', id: '2GS6' }, { source: 'HGNC', id: 'HGNC:3236' }],
    });
    it('enrich twice with fixed nowIso -> byte-identical JSON + sorted arrays', () => {
        const t1 = target('P00533'), t2 = target('P00533');
        enrichTargetsWithUniprot([t1], idxOf([richRec()]), OPTS);
        enrichTargetsWithUniprot([t2], idxOf([richRec()]), OPTS);
        expect(JSON.stringify(t1)).toBe(JSON.stringify(t2));
        expect(t1.ec_numbers).toEqual(['2.7.10.1', '3.1.1.1']);
        expect(t1.uniprot_secondary_accessions).toEqual(['B00001', 'Q99999']);
        expect(t1.db_xrefs).toEqual([{ source: 'HGNC', id: 'HGNC:3236' }, { source: 'PDB', id: '2GS6' }]);
        expect(t1.provenance.sources.map(s => s.source)).toEqual(['open_targets', 'uniprot_swissprot']);
    });
    it('provenance.sources kept in fixed history order even if uniprot precedes chembl', () => {
        const t = target('P00533', {
            provenance: {
                sources: [
                    { source: 'chembl_bioactivity', source_id: 'CHEMBL203', timestamp: NOW },
                    { source: 'open_targets', source_id: 'ENSG1', timestamp: NOW },
                ],
                last_updated: NOW,
            },
        });
        enrichTargetsWithUniprot([t], idxOf([uniRec('P00533')]), OPTS);
        expect(t.provenance.sources.map(s => s.source)).toEqual(['open_targets', 'chembl_bioactivity', 'uniprot_swissprot']);
    });
});

describe('9606-REMOVAL regression', () => {
    it('OT-seeded target with NO UniProt match -> organism === null (lie gone, not re-introduced)', () => {
        const t = target('P00533');
        const { stats } = enrichTargetsWithUniprot([t], idxOf([uniRec('P88888')]), OPTS);
        expect(stats.unmatched_target).toBe(1);
        expect(t.organism).toBeNull();
    });
});

describe('PROVENANCE / license', () => {
    it('matched target gains uniprot_swissprot source with license cc-by-4.0 + release', () => {
        const t = target('P00533');
        enrichTargetsWithUniprot([t], idxOf([uniRec('P00533')]), OPTS);
        const uni = t.provenance.sources.find(s => s.source === 'uniprot_swissprot');
        expect(uni.license).toBe('cc-by-4.0');
        expect(uni.release).toBe(RELEASE);
        expect(uni.source_id).toBe('P00533');
        expect(uni.timestamp).toBe(NOW);
        expect(t.license).toBe('cc-by-4.0');
        expect(t.provenance.last_updated).toBe(NOW);
    });
    it('matched twice (idempotent provenance) -> only one uniprot_swissprot source', () => {
        const t = target('P00533'), rec = uniRec('P00533');
        mergeUniprotIntoTarget(t, rec, OPTS);
        mergeUniprotIntoTarget(t, rec, OPTS);
        expect(t.provenance.sources.filter(s => s.source === 'uniprot_swissprot')).toHaveLength(1);
    });
});

describe('NO-OVERWRITE — OT fields win, only nulls filled', () => {
    it('existing approved_name/symbol kept; UniProt does not overwrite', () => {
        const t = target('P00533', { approved_name: 'OT-authoritative name', approved_symbol: 'OT_SYM' });
        enrichTargetsWithUniprot([t], idxOf([uniRec('P00533')]), OPTS);
        expect(t.approved_name).toBe('OT-authoritative name');
        expect(t.approved_symbol).toBe('OT_SYM');
    });
    it('null OT fields ARE filled from UniProt recommended_name/gene_symbol', () => {
        const t = target('P00533');
        enrichTargetsWithUniprot([t], idxOf([uniRec('P00533')]), OPTS);
        expect(t.approved_name).toBe('Epidermal growth factor receptor');
        expect(t.approved_symbol).toBe('EGFR');
    });
    it('existing ChEMBL-skeleton organism is NOT overwritten by UniProt organism', () => {
        const t = target('P00533', { organism: { scientific_name: 'Rattus norvegicus', taxon_id: 10116 } });
        enrichTargetsWithUniprot([t], idxOf([uniRec('P00533')]), OPTS);
        expect(t.organism.taxon_id).toBe(10116);
    });
    it('union db_xrefs (dedupe + (source,id) sort) + function_descriptions (existing-first dedupe)', () => {
        const t = target('P00533', {
            db_xrefs: [{ source: 'Ensembl', id: 'ENSG1' }],
            function_descriptions: ['OT description.'],
        });
        enrichTargetsWithUniprot([t], idxOf([uniRec('P00533', {
            db_xrefs: [{ source: 'HGNC', id: 'HGNC:3236' }, { source: 'Ensembl', id: 'ENSG1' }],
            function_descriptions: ['Receptor tyrosine kinase.', 'OT description.'],
        })]), OPTS);
        expect(t.db_xrefs).toEqual([{ source: 'Ensembl', id: 'ENSG1' }, { source: 'HGNC', id: 'HGNC:3236' }]);
        expect(t.function_descriptions).toEqual(['OT description.', 'Receptor tyrosine kinase.']);
    });
});

describe('input order preserved', () => {
    it('enrichTargetsWithUniprot returns targets in INPUT ORDER', () => {
        const ts = [target('Q9Y5N6'), target('P00533'), target('B00001')];
        const { targets } = enrichTargetsWithUniprot(ts, idxOf([uniRec('P00533')]), OPTS);
        expect(targets.map(t => t.uniprot_accession)).toEqual(['Q9Y5N6', 'P00533', 'B00001']);
    });
});
