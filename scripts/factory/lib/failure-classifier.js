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
    // SAFETY — adverse events, toxicity, DSMB safety stop
    { category: 'SAFETY', confidence: 80, patterns: [
        /adverse event/i, /\bSAE\b/, /toxicit/i, /side effect/i,
        /safety concern/i, /safety signal/i, /safety reason/i,
        /safety issue/i, /\bDSMB\b.*safet/i, /data monitoring.*safet/i,
        /serious.*adverse/i, /unacceptable.*toxicit/i,
        /drug.related.*death/i, /unexpected.*safety/i,
        /histological findings/i, /precautionary measure/i,
    ]},

    // EFFICACY — futility, lack of efficacy, interim no-difference
    { category: 'EFFICACY', confidence: 80, patterns: [
        /lack of efficacy/i, /no efficacy/i, /futility/i, /futile/i,
        /not effective/i, /did not (meet|show|demonstrate).*efficacy/i,
        /failed to (show|demonstrate)/i, /interim analysis.*futility/i,
        /primary endpoint.*not met/i, /insufficient.*response/i,
        /interim analysis.*(no difference|no efficacy|study closure)/i,
        /(treatment|drug|intervention).*not effective/i,
        /no significant.*(difference|advantage|benefit)/i,
        /no.*clinical advantage/i, /efficacy of.*rendered.*less relevant/i,
    ]},

    // ENROLLMENT — recruitment / accrual / inclusion failure (not a drug failure)
    { category: 'ENROLLMENT', confidence: 75, patterns: [
        /slow accrual/i, /slow recruit/i, /slow enroll/i,
        /unable to (recruit|enroll)/i, /could not.*recruit/i,
        /poor (accrual|enrollment|recruitment)/i,
        /insufficient.*(enrollment|subjects|patients)/i,
        /no longer.*recruit/i, /accrual.*goal/i,
        /enrollment.*(stop|halt|slow|low|lagging|delayed|not met)/i,
        /low (enrollment|recruitment|accrual|inclusion)/i,
        /lagging enroll/i, /inadequate accrual/i, /no accrual/i,
        /lack of (accrual|enrol|recruit|inclusion|enroll)/i,
        /not finding patients/i, /not reaching recruitment/i,
        /recruitment (difficult|failure|too slow|not.*met|not.*feasible|not.*goal|did not.*meet)/i,
        /inclusion (rate|difficult)/i, /subjects? did not meet/i,
        /no enrollment/i, /no participants.*enroll/i, /administratively closed/i,
        /target enrollment/i, /enroll(ment)? was not met/i,
        /delayed patient enrollment/i, /abandoned.*accrual/i,
        /stopped enroll/i, /never (initiated|enrolled)/i,
    ]},

    // FUNDING
    { category: 'FUNDING', confidence: 85, patterns: [
        /no funding/i, /lack of fund/i, /loss of fund/i, /no.*fund/i,
        /financial reason/i, /financial constraint/i,
        /budget/i, /grant.*(end|expired|denied)/i,
        /sponsor.*(withdrew|withdrawn).*(support|funding|fund)/i,
        /(receive|received) (no )?funding/i, /did not receive funding/i,
    ]},

    // LOGISTICS — supply, manufacturing, site, equipment, personnel
    { category: 'LOGISTICS', confidence: 75, patterns: [
        /shortage.*suppl/i, /supply.*(shortage|issue|problem)/i,
        /manufactur/i, /drug.*(unavailable|shortage|discontinued|expired)/i,
        /\bIMP expired/i, /(drug|device).*(no longer available|discontinued)/i,
        /site.*(closed|unavailable)/i, /investigator.*(unavailable|left|moved|leaving|abroad)/i,
        /surgery.*stopped/i, /unable to (obtain|source|produce)/i,
        /equipment.*(failure|issue|technical|problem)/i,
        /technical (problem|limit|failure)/i,
        /staff.*(shortage|left|unavailable|turnover)/i,
        /personnel.*(lack|left|unavailable)/i,
        /lack of.*personnel/i, /no clinical investigator/i,
        /loss of.*team/i, /pharmaceutical company discontinued/i,
        /infusion set/i,
    ]},

    // BUSINESS — sponsor decision, PI change, protocol/strategy change,
    // administrative withdrawal (non-funding, non-recruitment)
    { category: 'BUSINESS', confidence: 70, patterns: [
        /sponsor (decision|decided|suspended|withdrew|terminat)/i,
        /business (decision|reason)/i, /strategic (decision|reason|change)/i,
        /protocol.*(amendment|modify|modified|change|deviation)/i,
        /several studies.*(at the same time|going on)/i,
        /competing stud/i, /redundant.*stud/i, /superseded/i,
        /administrative (reason|decision|withdrawal|closed)/i,
        /\bIRB\b.*(withdrew|reviewing|hold|on hold)/i,
        /company.*(decision|decided|discontinued)/i,
        /structural change/i, /change in clinical strategy/i,
        /\bPI\b.*(left|leaving|change|moved|withdrew|no longer|not at|abroad|graduation|medical leave)/i,
        /principal investigator.*(left|leaving|change|move|withdrew|disagree)/i,
        /investigator (moved|left|leaving|changed)/i,
        /sponsor.*did not reach.*agreement/i,
        /(study|research) (cancelled|cancelled|abandoned|never initiated)/i,
        /study plan was changed/i, /not feasible/i,
        /study determined.*not.*feasible/i, /no progress/i,
        /agreed with the sponsor/i, /BARDA decision/i,
        /(terminate|terminated) contract/i, /development terminated/i,
        /research(ers)?.*(finished|unable to continue|left)/i,
        /staff turnover/i, /prohibitively expensive/i,
    ]},

    // REGULATORY — ethics / IRB / EC approval issues
    { category: 'REGULATORY', confidence: 80, patterns: [
        /(IRB|EC|ethics|ethical).*(reject|denied|approval|approve|issue|review|hold|committee)/i,
        /not approved by (IRB|EC|ethics)/i,
        /(rejected|denied|withdrew|withdrawn).*(IRB|ethics|ethical|EC)/i,
        /no (IRB|EC|ethics|ethical) approval/i,
        /(IRB|ethics committee|ethics).*decision/i,
        /ethical (issue|concern|reason)/i,
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
