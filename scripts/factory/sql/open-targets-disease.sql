-- Open Targets disease table extract (cycle 23 PR-SID-1.6b-pre.1a).
--
-- Executed by .github/workflows/factory-open-targets-bulk.yml ingest job
-- after Parquet files are downloaded to /tmp/disease/. Produces one
-- pre-projected JSON line per OT disease row at /tmp/disease-enriched.jsonl
-- with snake_case keys consumed verbatim by
-- scripts/factory/open-targets-disease-harvest.js.
--
-- Anchor convention (PR-SID-1.6b precedent, analogous to Phase 1.4 target
-- multi-canon UniProt+Ensembl): OT disease.id is the mixed-namespace string
-- 'EFO_xxxxxxx' or 'MONDO_xxxxxxx'. SQL layer projects the raw mixed
-- diseaseId verbatim; namespace split into efo_id / mondo_id happens in
-- disease-linker.js (Sciweon layer per [[sid_architecture]] §19 truth-
-- isolation — Layer 1 anchor extraction is downstream of SQL projection).
--
-- Triple-lock anchor: ALL OT disease rows in scope; no Top-N filtering;
-- per [[no_shortcut_in_science]] 规模 leg.
--
-- Conservative field set: id / name / description / synonyms / therapeutic_areas
-- / parents / ancestors / db_xrefs. Additional OT fields (obsoleteTerms,
-- code URI form, etc.) deferred to follow-up if downstream consumers need
-- them. Synonyms STRUCT projected raw; harvester selects sub-fields.

COPY (
  SELECT
    d.id AS disease_id,
    d.name AS name,
    d.description AS description,
    d.synonyms AS synonyms,
    d.therapeuticAreas AS therapeutic_areas,
    d.parents AS parents,
    d.ancestors AS ancestors,
    d.dbXRefs AS db_xrefs,
    d.code AS code
  FROM '/tmp/disease/*.parquet' d
) TO '/tmp/disease-enriched.jsonl' (FORMAT JSON, ARRAY false);
