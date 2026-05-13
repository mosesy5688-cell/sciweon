/**
 * Failure Classifier V0.1 — keyword-based baseline classification.
 *
 * Classifies trial whyStopped text into failure categories.
 * V0.1 baseline: keyword rules, ~70-80% accuracy.
 * V0.4 upgrade path: NLP model (BioBERT or domain LLM), target 90%+.
 *
 * Categories (aligned with brain/SCIWEON_NEGATIVE_EVIDENCE_DB.md §2):
 *   SAFETY       — adverse events, toxicity, safety concerns
 *   EFFICACY     — futility, lack of efficacy
 *   ENROLLMENT   — recruitment/accrual failure (NOT a drug failure)
 *   FUNDING      — financial issues
 *   LOGISTICS    — supply, manufacturing, site issues
 *   BUSINESS     — sponsor decision, protocol changes, strategic
 *   COVID        — pandemic-related disruption
 *   UNKNOWN      — empty or unclassifiable
 *
 * Provenance: each classification has source='v0.1_keyword_classifier' + confidence.
 * Agent contract: confidence < 70 = treat as hint, not fact.
 */

const RULES = [
    // SAFETY — adverse events, toxicity
    { category: 'SAFETY', confidence: 80, patterns: [
        /adverse event/i, /\bSAE\b/, /toxicit/i, /side effect/i,
        /safety concern/i, /safety signal/i, /safety reason/i,
        /serious.*adverse/i, /unacceptable.*toxicit/i,
        /drug.related.*death/i, /unexpected.*safety/i,
    ]},

    // EFFICACY — futility, lack of efficacy
    { category: 'EFFICACY', confidence: 80, patterns: [
        /lack of efficacy/i, /no efficacy/i, /futility/i,
        /futile/i, /did not (meet|show|demonstrate).*efficacy/i,
        /failed to (show|demonstrate)/i, /interim analysis.*futility/i,
        /primary endpoint.*not met/i, /insufficient.*response/i,
    ]},

    // ENROLLMENT — recruitment failure (not a drug failure)
    { category: 'ENROLLMENT', confidence: 75, patterns: [
        /slow accrual/i, /slow recruit/i, /slow enroll/i,
        /unable to (recruit|enroll)/i, /could not.*recruit/i,
        /poor (accrual|enrollment|recruitment)/i,
        /insufficient.*(enrollment|subjects|patients)/i,
        /no longer.*recruit/i, /accrual.*goal/i,
        /enrollment.*(stop|halt|slow)/i, /no.*subjects/i,
    ]},

    // FUNDING
    { category: 'FUNDING', confidence: 85, patterns: [
        /no funding/i, /lack of fund/i, /loss of fund/i,
        /financial reason/i, /financial constraint/i,
        /budget/i, /grant.*(end|expired|denied)/i,
        /sponsor.*(withdrew|withdrawn).*support/i,
    ]},

    // LOGISTICS — supply, manufacturing, site
    { category: 'LOGISTICS', confidence: 75, patterns: [
        /shortage.*suppl/i, /supply.*(shortage|issue|problem)/i,
        /manufactur/i, /drug.*(unavailable|shortage)/i,
        /site.*(closed|unavailable)/i, /investigator.*(unavailable|left)/i,
        /surgery.*stopped/i, /unable to (obtain|source|produce)/i,
        /equipment.*(failure|issue)/i, /staff.*(shortage|left|unavailable)/i,
    ]},

    // BUSINESS — sponsor decision, protocol changes
    { category: 'BUSINESS', confidence: 70, patterns: [
        /sponsor (decision|decided)/i, /business (decision|reason)/i,
        /strategic (decision|reason)/i, /protocol.*(amendment|modify|modified|change)/i,
        /several studies.*(at the same time|going on)/i,
        /administrative (reason|decision)/i, /company.*(decision|decided)/i,
        /redundant.*stud/i, /superseded/i, /structural change/i,
    ]},

    // COVID
    { category: 'COVID', confidence: 90, patterns: [
        /covid/i, /pandemic/i, /SARS-CoV-2/i, /coronavirus/i,
    ]},
];

/**
 * Classify a single whyStopped text.
 * Returns { category, confidence, matched_patterns, source }.
 */
export function classifyFailure(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return {
            category: 'UNKNOWN',
            confidence: 0,
            matched_patterns: [],
            source: 'v0.1_keyword_classifier',
            note: 'empty_status_reason',
        };
    }

    // Score each category — first match wins; ties broken by confidence
    const matches = [];
    for (const rule of RULES) {
        for (const pat of rule.patterns) {
            if (pat.test(text)) {
                matches.push({ category: rule.category, confidence: rule.confidence, pattern: pat.source });
            }
        }
    }

    if (matches.length === 0) {
        return {
            category: 'UNKNOWN',
            confidence: 30, // low: text exists but no rule matched (V0.4 NLP will improve)
            matched_patterns: [],
            source: 'v0.1_keyword_classifier',
            note: 'no_keyword_match',
        };
    }

    // If multiple categories match, return highest-confidence category;
    // record all matched_patterns for transparency.
    const byCategory = new Map();
    for (const m of matches) {
        if (!byCategory.has(m.category)) byCategory.set(m.category, { count: 0, confidence: m.confidence, patterns: [] });
        const e = byCategory.get(m.category);
        e.count++;
        e.confidence = Math.max(e.confidence, m.confidence);
        e.patterns.push(m.pattern);
    }

    // Primary = category with highest (confidence * count score)
    let primary = null;
    let primaryScore = -1;
    for (const [cat, data] of byCategory) {
        const score = data.confidence + data.count * 5;
        if (score > primaryScore) {
            primaryScore = score;
            primary = { category: cat, confidence: data.confidence, matched_patterns: data.patterns };
        }
    }

    // If 2+ categories matched, slightly lower confidence (ambiguity)
    if (byCategory.size > 1) {
        primary.confidence = Math.max(50, primary.confidence - 10);
        primary.note = `ambiguous_${byCategory.size}_categories`;
        primary.alternative_categories = [...byCategory.keys()].filter(c => c !== primary.category);
    }

    primary.source = 'v0.1_keyword_classifier';
    return primary;
}

/**
 * Batch classify negative evidence records.
 * Mutates each record in place adding `failure_classification` field.
 * Returns summary stats.
 */
export function classifyBatch(negEvidenceRecords) {
    const stats = {};
    for (const rec of negEvidenceRecords) {
        const result = classifyFailure(rec.status_reason);
        rec.failure_classification = result;
        stats[result.category] = (stats[result.category] ?? 0) + 1;
    }
    return stats;
}
