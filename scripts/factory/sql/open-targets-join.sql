-- Open Targets multi-table JOIN extract (cycle 23 PR-OT-3c).
--
-- Executed by .github/workflows/factory-open-targets-bulk.yml ingest job
-- after Parquet files are downloaded to /tmp/<table>/. Produces one
-- pre-aggregated JSON line per OT drug at /tmp/drug-enriched.jsonl with
-- snake_case keys consumed verbatim by scripts/factory/open-targets-harvest.js.
--
-- Join graph (6 tables; see [[project_cycle23_pr_ot_1_shipped]] memory):
--   drug_molecule (anchor, 22,230 drugs by ChEMBL ID)
--     |- drug_mechanism_of_action via list_contains(chemblIds, dm.id) -> mechanisms[]
--     |- drug_warning             via list_contains(chemblIds, dm.id) -> warnings[]
--     |- clinical_indication      via drugId = dm.id                  -> indications[]
--     |    \- clinical_report      via list_contains(clinicalReportIds, cr.id) -> indications[].trials[]
--     \- clinical_target          via drugId = dm.id                  -> target_associations[]
--
-- STRUCT literal aliases ('snake_case_key': dm.camelCaseColumn) move the
-- case-conversion from Node into SQL so the Node-side aggregator
-- (lib/open-targets-aggregator.js) consumes snake_case directly.
--
-- Triple-lock anchor (per [[no_shortcut_in_science]] + [[researcher_needs_anchor]]):
-- All 6 tables in scope because researcher use cases require trial-level
-- evidence under each indication. clinical_report nesting is non-severable
-- from the compound entity per the 3-question audit 2026-05-24.

COPY (
  SELECT
    dm.id AS id,
    dm.canonicalSmiles AS canonical_smiles,
    dm.inchiKey AS inchi_key,
    dm.drugType AS drug_type,
    dm.name AS name,
    dm.parentId AS parent_id,
    dm.tradeNames AS trade_names,
    dm.synonyms AS synonyms,
    dm.crossReferences AS cross_references,
    dm.childChemblIds AS child_chembl_ids,
    dm.maximumClinicalStage AS maximum_clinical_stage,
    dm.description AS description,
    (SELECT LIST({
      'action_type': dmoa.actionType,
      'mechanism': dmoa.mechanismOfAction,
      'target_name': dmoa.targetName,
      'target_type': dmoa.targetType,
      'targets': dmoa.targets,
      'references': dmoa.references
    })
    FROM '/tmp/drug_mechanism_of_action/*.parquet' dmoa
    WHERE list_contains(dmoa.chemblIds, dm.id)
    ) AS mechanisms,
    (SELECT LIST({
      'warning_type': dw.warningType,
      'toxicity_class': dw.toxicityClass,
      'country': dw.country,
      'description': dw.description,
      'efo_term': dw.efoTerm,
      'efo_id': dw.efoId,
      'efo_id_for_warning_class': dw.efoIdForWarningClass,
      'references': dw.references
    })
    FROM '/tmp/drug_warning/*.parquet' dw
    WHERE list_contains(dw.chemblIds, dm.id)
    ) AS warnings,
    (SELECT LIST({
      'disease_id': ci.diseaseId,
      'max_clinical_stage': ci.maxClinicalStage,
      'trials': (
        SELECT LIST({
          'report_id': cr.id,
          'trial_phase': cr.trialPhase,
          'trial_clinical_stage': cr.clinicalStage,
          'trial_phase_from_source': cr.phaseFromSource,
          'trial_overall_status': cr.trialOverallStatus,
          'year': cr.year,
          'trial_official_title': cr.trialOfficialTitle,
          'trial_why_stopped': cr.trialWhyStopped,
          'trial_study_type': cr.trialStudyType,
          'trial_primary_purpose': cr.trialPrimaryPurpose,
          'url': cr.url,
          'side_effects': cr.sideEffects
        })
        FROM '/tmp/clinical_report/*.parquet' cr
        WHERE list_contains(ci.clinicalReportIds, cr.id)
      )
    })
    FROM '/tmp/clinical_indication/*.parquet' ci
    WHERE ci.drugId = dm.id
    ) AS indications,
    (SELECT LIST({
      'target_id': ct.targetId
    })
    FROM '/tmp/clinical_target/*.parquet' ct
    WHERE ct.drugId = dm.id
    ) AS target_associations
  FROM '/tmp/drug_molecule/*.parquet' dm
) TO '/tmp/drug-enriched.jsonl' (FORMAT JSON, ARRAY false);
