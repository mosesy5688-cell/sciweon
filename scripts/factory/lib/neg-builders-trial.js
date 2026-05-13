/**
 * NegEvidence builders for trial-derived signals.
 *
 * Two record types from trials data:
 *   - trial_failure: from negative-evidence-raw.jsonl (V0.1 classifier output)
 *   - serious_adverse_event_per_trial: from trial.results.serious_events_count
 *     (V0.3.5 CT.gov ResultsSection)
 *
 * Severity mapping:
 *   trial_failure SAFETY     -> critical
 *   trial_failure EFFICACY   -> major
 *   trial_failure ENROLLMENT -> minor (not a drug failure)
 *   trial_failure OTHER      -> unknown
 *   serious AE > 100         -> major
 *   serious AE > 10          -> minor
 */

function severityForTrialFailure(category, confidence) {
    if (category === 'SAFETY') return 'critical';
    if (category === 'EFFICACY' || category === 'REGULATORY') return 'major';
    if (category === 'ENROLLMENT' || category === 'LOGISTICS' || category === 'FUNDING'
        || category === 'BUSINESS' || category === 'COVID') return 'minor';
    if (confidence < 50) return 'unknown';
    return 'unknown';
}

export function* buildTrialNegEvidence(trials, negRaw) {
    const trialByNct = new Map();
    for (const t of trials) {
        if (t.nct_id) trialByNct.set(t.nct_id, t);
    }
    const now = new Date().toISOString();

    // trial_failure from V0.1 classifier (negative-evidence-raw.jsonl)
    for (const n of negRaw) {
        const cls = n.failure_classification ?? {};
        const ts = trialByNct.get(n.nct_id);
        const provSource = ts?.provenance?.sources?.[0]?.source === 'ctis' ? 'ctis_ema' : 'clinicaltrials_gov';
        yield {
            id: `sciweon::neg::trial::${n.nct_id}`,
            evidence_type: 'trial_failure',
            subject: {
                compound_id: n.compound_id ?? undefined,
                trial_id: ts ? ts.id : `sciweon::trial::${n.nct_id}`,
            },
            failure: {
                reason_category: cls.category ?? 'OTHER',
                reason_text: n.status_reason ?? null,
                extraction_method: 'v0.1_keyword_classifier',
                extraction_confidence: cls.confidence ?? 30,
            },
            detail: {
                nct_id: n.nct_id,
                phase: n.phase ?? null,
                conditions: n.conditions ?? null,
                status: n.status ?? null,
            },
            occurred_date: ts?.dates?.completion ?? null,
            observed_date: now,
            severity: severityForTrialFailure(cls.category, cls.confidence ?? 0),
            confidence: {
                overall: Math.max(40, Math.min(80, cls.confidence ?? 50)),
                extraction_quality: cls.confidence ?? 50,
                source_reliability: 70,
                method: 'negative_evidence_v1',
            },
            provenance: {
                primary_source: provSource,
                source_id: n.nct_id,
                extraction_timestamp: now,
                extraction_method: 'sciweon_v0.1_keyword_classifier',
            },
        };
    }

    // serious_adverse_event_per_trial from V0.3.5 CT.gov ResultsSection
    for (const t of trials) {
        const cnt = t.results?.serious_events_count ?? 0;
        if (cnt <= 0) continue;
        const compoundId = t.interventions?.find(i => i.compound_id)?.compound_id;
        let severity = 'minor';
        if (cnt >= 100) severity = 'major';
        if (cnt >= 1000) severity = 'critical';
        yield {
            id: `sciweon::neg::ae::${t.nct_id}`,
            evidence_type: 'serious_adverse_event_per_trial',
            subject: {
                compound_id: compoundId ?? undefined,
                trial_id: t.id,
            },
            failure: {
                reason_category: 'serious_adverse_events_recorded',
                extraction_method: 'source_provided',
                extraction_confidence: 95,
            },
            detail: {
                serious_events_count: cnt,
                other_events_count: t.results?.other_events_count ?? 0,
                phase: t.phase,
                status: t.status,
            },
            occurred_date: t.dates?.completion ?? null,
            observed_date: now,
            severity,
            confidence: {
                overall: 90,
                extraction_quality: 95,
                source_reliability: 90,
                method: 'negative_evidence_v1',
            },
            provenance: {
                primary_source: 'clinicaltrials_gov',
                source_id: t.nct_id,
                extraction_timestamp: now,
                extraction_method: 'ctgov_results_section_v2',
            },
        };
    }
}
