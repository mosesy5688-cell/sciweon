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

export function classifyViolations(errors, derivedPatterns = DERIVED_PATH_PATTERNS) {
    const primary = [];
    const derived = [];
    if (!Array.isArray(errors)) return { primary, derived };
    for (const err of errors) {
        const path = err?.path ?? '';
        const isDerived = derivedPatterns.some(p => p.test(path));
        (isDerived ? derived : primary).push(err);
    }
    return { primary, derived };
}
