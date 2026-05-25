-- Open Targets target table extract (cycle 23 PR-SID-1.4-pre.1a).
--
-- Executed by .github/workflows/factory-open-targets-bulk.yml ingest job
-- after Parquet files are downloaded to /tmp/target/. Produces one
-- pre-projected JSON line per OT target row at /tmp/target-enriched.jsonl
-- with snake_case keys consumed verbatim by
-- scripts/factory/open-targets-target-harvest.js.
--
-- Defect-9 hard filter (Layer 1): WHERE biotype = 'protein_coding'.
-- Non-protein targets (lncRNA / rna_pseudogene / etc.) are dropped at
-- the SQL boundary so they never reach Phase 1.4 stamping classifier
-- (would otherwise trigger zero-tolerance hard-fail cascade).
--
-- Defect-8 isoform truncation roll-up handled in JS harvest (sanitizeUniprot
-- strips -N suffix). SQL keeps raw uniprot_swissprot + uniprot_trembl
-- lists; harvest deduplicates after truncation.
--
-- Triple-lock anchor: all 7872+ protein-coding targets in scope; no
-- Top-N filtering; per [[no_shortcut_in_science]] 规模 leg.

COPY (
  SELECT
    t.id AS ensembl_gene_id,
    t.approvedSymbol AS approved_symbol,
    t.approvedName AS approved_name,
    t.biotype AS biotype,
    list_transform(
      list_filter(t.proteinIds, p -> p.source = 'uniprot_swissprot'),
      p -> p.id
    ) AS uniprot_swissprot_ids,
    list_transform(
      list_filter(t.proteinIds, p -> p.source = 'uniprot_trembl'),
      p -> p.id
    ) AS uniprot_trembl_ids,
    t.dbXrefs AS db_xrefs,
    t.targetClass AS target_class,
    list_transform(t.synonyms, s -> s.label) AS synonyms,
    list_transform(t.symbolSynonyms, ss -> ss.label) AS symbol_synonyms,
    t.functionDescriptions AS function_descriptions,
    list_transform(t.subcellularLocations, sl -> sl.location)
      AS subcellular_locations,
    t.genomicLocation AS genomic_location
  FROM '/tmp/target/*.parquet' t
  WHERE t.biotype = 'protein_coding'
) TO '/tmp/target-enriched.jsonl' (FORMAT JSON, ARRAY false);
