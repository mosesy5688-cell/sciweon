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
export const SCOPE_VIOLATION_RULES = [
    {
        pathPattern: /\.molecular_weight\.value$/,
        errorPattern: /^[\d.]+ > max \d/,
        exclusion_reason: 'macromolecule_out_of_scope',
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
