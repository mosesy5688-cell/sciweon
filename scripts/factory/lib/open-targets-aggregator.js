/**
 * Open Targets per-sub-field row aggregators (cycle 23 PR-OT-3c).
 *
 * Split out of lib/open-targets-sql.js to keep that file under the
 * Art 5.1 250-line cap AND to give each sub-field its own pure-function
 * mapper for unit testability. The DuckDB COPY ... TO JSON output
 * pre-aggregates each drug row with nested mechanisms/warnings/indications/
 * target_associations arrays already shaped by the JOIN SQL; this module
 * just renames camelCase OT fields to Sciweon snake_case canonical case
 * and filters obviously malformed entries.
 *
 * Architecture note: the SQL emit path already produces snake_case via
 * DuckDB STRUCT literal aliases (e.g. `'action_type': dmoa.actionType`).
 * The mappers in this file are defensive guards for: (a) DuckDB column
 * name drift across OT releases, (b) malformed entries (null id / wrong
 * type), (c) downstream null-safety for JSON serialization. They are NOT
 * a second case-transformation layer.
 */

function isStringNonEmpty(v) {
    return typeof v === 'string' && v.length > 0;
}

function safeStringArray(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(x => typeof x === 'string' && x.length > 0);
}

/**
 * Transform one drug_mechanism_of_action row (already pre-shaped by the
 * JOIN SQL with snake_case keys) into a Sciweon mechanism entry.
 * Returns null on malformed input so the caller can filter.
 */
export function mapMechanism(row) {
    if (!row || typeof row !== 'object') return null;
    return {
        action_type: row.action_type ?? null,
        mechanism: row.mechanism ?? null,
        target_name: row.target_name ?? null,
        target_type: row.target_type ?? null,
        targets: safeStringArray(row.targets),
        references: Array.isArray(row.references) ? row.references : [],
    };
}

/**
 * Transform one drug_warning row into a Sciweon warning entry.
 * `references` here is STRUCT(id, source, url)[] in OT 26.03; we preserve
 * the shape verbatim because PR-OT-4 may need the structured form for
 * NegEvidence DB linkage.
 */
export function mapWarning(row) {
    if (!row || typeof row !== 'object') return null;
    return {
        warning_type: row.warning_type ?? null,
        toxicity_class: row.toxicity_class ?? null,
        country: row.country ?? null,
        description: row.description ?? null,
        efo_term: row.efo_term ?? null,
        efo_id: row.efo_id ?? null,
        efo_id_for_warning_class: row.efo_id_for_warning_class ?? null,
        references: Array.isArray(row.references) ? row.references : [],
    };
}

/**
 * Transform one clinical_indication row (with nested trials[] pre-joined
 * from clinical_report via clinicalReportIds[]) into a Sciweon indication
 * entry. The trial detail is researcher-critical (efficacy + safety
 * context for the indication) — see [[researcher_needs_anchor]] decision
 * 2026-05-24 for why this is non-severable from PR-OT-3c.
 */
export function mapIndication(row) {
    if (!row || typeof row !== 'object') return null;
    if (!isStringNonEmpty(row.disease_id)) return null;
    return {
        disease_id: row.disease_id,
        max_clinical_stage: row.max_clinical_stage ?? null,
        trials: Array.isArray(row.trials)
            ? row.trials.map(mapTrial).filter(t => t !== null)
            : [],
    };
}

/**
 * Transform one clinical_report row (nested under an indication) into a
 * Sciweon trial entry. Subset of clinical_report's 24 cols — selected for
 * researcher use cases (phase / status / year / title / side effects /
 * why_stopped) per the PR-OT-3c scope analysis 2026-05-24.
 */
export function mapTrial(row) {
    if (!row || typeof row !== 'object') return null;
    if (!isStringNonEmpty(row.report_id)) return null;
    return {
        report_id: row.report_id,
        trial_phase: row.trial_phase ?? null,
        trial_clinical_stage: row.trial_clinical_stage ?? null,
        trial_phase_from_source: row.trial_phase_from_source ?? null,
        trial_overall_status: row.trial_overall_status ?? null,
        year: typeof row.year === 'number' ? row.year : null,
        trial_official_title: row.trial_official_title ?? null,
        trial_why_stopped: row.trial_why_stopped ?? null,
        trial_study_type: row.trial_study_type ?? null,
        trial_primary_purpose: row.trial_primary_purpose ?? null,
        url: row.url ?? null,
        side_effects: Array.isArray(row.side_effects) ? row.side_effects : [],
    };
}

/**
 * Transform one clinical_target row into a Sciweon target_association
 * entry. clinical_target is the drug -> target evidence via clinical
 * trials; complements drug_mechanism_of_action's targets which is
 * mechanism-level. Drops entries with missing target_id.
 */
export function mapTargetAssociation(row) {
    if (!row || typeof row !== 'object') return null;
    if (!isStringNonEmpty(row.target_id)) return null;
    return {
        target_id: row.target_id,
        source: 'open_targets_clinical',
    };
}
