/**
 * V0.5.7 — Schema field tier classifier.
 *
 * The validation gate (lib/validation-gate.js) historically threw on ANY
 * field violation in REJECT mode. This was too strict for *derived* fields
 * (Sciweon-computed: confidence envelope, mention crosslinks, stats
 * aggregations) — a Sciweon-side scoring drift would abort an entire
 * stage even though no primary-source data was corrupted.
 *
 * V0.5.7 H2b-5: REJECT mode now throws only when at least one violation
 * is on a *primary* field. Derived-only violations log as warnings and
 * the stage proceeds (matches WARN-mode behavior for that subset).
 *
 * Patterns are matched against the `path` of each validation violation
 * (e.g. `paper:sciweon::paper::pubmed::123.mentioned_compounds[0].mention_confidence`).
 */

export const DERIVED_PATH_PATTERNS = [
    /\.confidence(\.|\[|$)/,             // confidence envelope (entire subtree)
    /\.cross_source_agreement(\.|\[|$)/,
    /\.stats(\.|\[|$)/,                   // aggregations
    /\.mentioned_compounds(\.|\[|$)/,     // paper crosslink
    /\.mentioned_trial_ids(\.|\[|$)/,
    /\.is_negative_outcome(\.|\[|$)/,     // trial computed
];

// 2026-05-27 (PR-HARVEST-SCOPE-TIER): scope violations are intentional
// out-of-domain exclusions, not data quality regressions. They should
// SKIP the record + telemetry-bucket the exclusion, NOT halt the chain.
//
// Each rule pairs a path pattern (which field) with an error pattern (which
// violation kind). Path-only match would over-trigger (e.g. molecular_weight.value
// missing-required should still be a primary violation; only > max triggers
// scope-exclusion semantics).
//
// Triggered by F1 run 26512200020 PubChem Harvest cron halt on CID:111615
// molecular_weight.value=18657 > max 10000 -- a known macromolecule outside
// Sciweon's small-molecule drug-graph scope, not a data quality regression.
// 2026-05-30 (PR-TRIAL-ISOLATION): CTIS (EU) trials carry legitimate
// multilingual, multi-compound combination descriptions whose
// interventions[].name / status_reason length recurrently outpaces the
// schema maxLength cap (halts at 635/2039/4020 chars across 4 F3 runs).
// This is boundary drift, not data corruption: a non-truncatable long
// primary-source string belongs in the scope tier (fail-soft skip + bucket),
// NOT a primary halt that nukes the entire F3 chain. The finite cap is kept
// as a runaway guard (NXVF shard 8-10MB); overflow now excludes the single
// trial. errorPattern is narrow (only `length N > maxLength` overflow), so a
// missing/typed/pattern violation on the same field is still primary.
export const SCOPE_VIOLATION_RULES = [
    {
        pathPattern: /\.molecular_weight\.value$/,
        errorPattern: /^[\d.]+ > max \d/,
        exclusion_reason: 'macromolecule_out_of_scope',
    },
    {
        pathPattern: /\.interventions\[\d+\]\.name$/,
        errorPattern: /^length \d+ > maxLength/,
        exclusion_reason: 'oversized_intervention_name',
    },
    {
        pathPattern: /\.status_reason$/,
        errorPattern: /^length \d+ > maxLength/,
        exclusion_reason: 'oversized_status_reason',
    },
    // 2026-06-06 (PR-T1.1a FDA UNCAP, R1 the KEYSTONE -- RESILIENCE FIRST):
    // fda_signals.* are preserve-all FDA-curated primary facts whose runaway
    // guards (compound.js / neg-evidence.js, lifted to the openFDA-measured
    // ceilings) are set WELL ABOVE the live P95 yet BELOW the NXVF shard guard.
    // Today these fields classify `primary` -> a single over-cap field would
    // THROW in REJECT mode (validation-gate.js) via cross-source-linker.js's
    // per-record gate -> halt the ENTIRE F3 chain for ALL records over ONE fat
    // field. The founder ruling is RESILIENCE before SCALE: an overflow on a
    // preserve-all FDA field must FAIL-SOFT (skip + telemetry the ONE record),
    // never hard-halt the stage. errorPattern stays narrow (only the overflow
    // kinds `items N > maxItems` / `length N > maxLength`), so a missing/typed/
    // pattern violation on the same field is still a primary halt.
    {
        pathPattern: /\.faers_top_adr_terms$/,
        errorPattern: /^items \d+ > maxItems/,
        exclusion_reason: 'oversized_faers_top_adr_terms',
    },
    {
        pathPattern: /\.faers_top_adr_terms\[\d+\]\.term$/,
        errorPattern: /^length \d+ > maxLength/,
        exclusion_reason: 'oversized_faers_adr_term',
    },
    {
        pathPattern: /\.application_numbers$/,
        errorPattern: /^items \d+ > maxItems/,
        exclusion_reason: 'oversized_application_numbers',
    },
    {
        pathPattern: /\.pharm_class_epc$/,
        errorPattern: /^items \d+ > maxItems/,
        exclusion_reason: 'oversized_pharm_class_epc',
    },
    {
        pathPattern: /\.pharm_class_moa$/,
        errorPattern: /^items \d+ > maxItems/,
        exclusion_reason: 'oversized_pharm_class_moa',
    },
    {
        pathPattern: /\.boxed_warning_text$/,
        errorPattern: /^length \d+ > maxLength/,
        exclusion_reason: 'oversized_boxed_warning_text',
    },
    {
        pathPattern: /\.boxed_warnings$/,
        errorPattern: /^items \d+ > maxItems/,
        exclusion_reason: 'oversized_boxed_warnings',
    },
    {
        pathPattern: /\.boxed_warnings\[\d+\]\.text$/,
        errorPattern: /^length \d+ > maxLength/,
        exclusion_reason: 'oversized_boxed_warning_item',
    },
    // neg-evidence (compound FDA NegEvidence reason text overflow).
    {
        pathPattern: /\.reason_text$/,
        errorPattern: /^length \d+ > maxLength/,
        exclusion_reason: 'oversized_reason_text',
    },
];

export function classifyViolations(
    errors,
    derivedPatterns = DERIVED_PATH_PATTERNS,
    scopeRules = SCOPE_VIOLATION_RULES,
) {
    const primary = [];
    const derived = [];
    const scope = [];
    if (!Array.isArray(errors)) return { primary, derived, scope };
    for (const err of errors) {
        const path = err?.path ?? '';
        const errStr = err?.error ?? '';
        const scopeHit = scopeRules.find(r => r.pathPattern.test(path) && r.errorPattern.test(errStr));
        if (scopeHit) {
            scope.push({ ...err, exclusion_reason: scopeHit.exclusion_reason });
            continue;
        }
        const isDerived = derivedPatterns.some(p => p.test(path));
        (isDerived ? derived : primary).push(err);
    }
    return { primary, derived, scope };
}
