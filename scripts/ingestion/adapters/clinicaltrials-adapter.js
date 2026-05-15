/**
 * ClinicalTrials.gov Adapter — Sciweon V0.1
 *
 * Fetches clinical trial data from ClinicalTrials.gov V2 REST API.
 *
 * API docs: https://clinicaltrials.gov/data-api/api
 * Base: https://clinicaltrials.gov/api/v2/studies
 * Public, no auth required.
 *
 * Search strategies (in order of preference):
 *   1. By intervention name (compound synonym → trials)
 *   2. By NCT ID (direct lookup)
 *
 * KEY for Negative Evidence (V0.4):
 *   TERMINATED/WITHDRAWN trials + whyStopped text = failure raw data
 */

import { scoreDataPoint } from '../../factory/lib/confidence-scorer.js';

const CT_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const REQUEST_TIMEOUT_MS = 20000;

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

/**
 * Fetch a single trial's results section by NCT ID. Returns only the
 * Sciweon-relevant subset (signal-level, not raw measurement data).
 *
 * V0.3.5 P0 — Agent needs to know "this trial completed AND we know
 * the outcomes" not just "this trial exists". Without results, Agent
 * cannot answer "did this drug work in trials?"
 *
 * Field strategy:
 *   - has_results: top-level boolean (most Agent queries gate on this)
 *   - primary_outcomes: titles + analyses-presence (decision navigation)
 *   - secondary_outcomes_count: integer (depth indicator)
 *   - enrollment_actual: integer (from participantFlow)
 *   - serious_events_count + other_events_count: integers
 *     (V0.4 NegEvidence Cat E full AE detail; here just counts)
 *
 * NOT consumed (Sciweon does not duplicate raw CT.gov measurement data):
 *   - outcome_measures[].classes[].categories[].measurements[] (raw values)
 *   - adverseEvents seriousEvents[] (individual records — V0.4 NegEvidence)
 *   - baselineCharacteristicsModule (aggregate population stats)
 */
export async function fetchResultsByNctId(nctId) {
    if (!nctId) return null;
    try {
        const url = `${CT_BASE}/${encodeURIComponent(nctId)}?format=json`;
        const data = await fetchJson(url);
        if (!data) return null;
        return extractResultsSignals(data);
    } catch (e) {
        console.warn(`[CT] results ${nctId}: ${e.message}`);
        return null;
    }
}

function extractResultsSignals(raw) {
    const hasResults = raw.hasResults === true;
    const rs = raw.resultsSection ?? {};
    const om = rs.outcomeMeasuresModule?.outcomeMeasures ?? [];
    const primary = om.filter(o => o.type === 'PRIMARY').map(o => ({
        title: (o.title ?? '').slice(0, 500),
        type: o.type,
        time_frame: (o.timeFrame ?? '').slice(0, 200),
        param_type: o.paramType ?? null,
        group_count: Array.isArray(o.groups) ? o.groups.length : 0,
        has_analyses: Array.isArray(o.analyses) && o.analyses.length > 0,
    }));
    const secondaryCount = om.filter(o =>
        o.type === 'SECONDARY' || o.type === 'OTHER_PRE_SPECIFIED' || o.type === 'POST_HOC').length;
    const pf = rs.participantFlowModule;
    let enrollmentActual = null;
    if (pf?.periods?.[0]?.milestones) {
        const started = pf.periods[0].milestones.find(m => m.type === 'STARTED');
        if (started) {
            const total = (started.achievements ?? []).reduce(
                (s, a) => s + (typeof a.numSubjects === 'string' ? parseInt(a.numSubjects, 10) || 0 : (a.numSubjects ?? 0)),
                0,
            );
            if (total > 0) enrollmentActual = total;
        }
    }
    const ae = rs.adverseEventsModule;
    return {
        has_results: hasResults,
        primary_outcomes: primary,
        secondary_outcomes_count: secondaryCount,
        enrollment_actual: enrollmentActual,
        serious_events_count: ae?.seriousEvents?.length ?? 0,
        other_events_count: ae?.otherEvents?.length ?? 0,
        results_extracted_at: new Date().toISOString(),
    };
}

/**
 * Search trials by intervention name.
 * Returns up to 100 trial records.
 */
export async function searchByIntervention(name, pageSize = 100) {
    try {
        const url = `${CT_BASE}?query.intr=${encodeURIComponent(name)}&pageSize=${pageSize}&format=json`;
        const data = await fetchJson(url);
        return data?.studies ?? [];
    } catch (e) {
        console.warn(`[CT] intervention "${name}": ${e.message}`);
        return [];
    }
}

/**
 * Map ClinicalTrials.gov phases array to a single phase number.
 * Phases can be: NA, EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4, PHASE1_PHASE2, etc.
 */
function normalizePhase(phases) {
    if (!phases || phases.length === 0) return null;
    const phaseMap = {
        'EARLY_PHASE1': 0,
        'PHASE1': 1, 'PHASE1_PHASE2': 1,
        'PHASE2': 2, 'PHASE2_PHASE3': 2,
        'PHASE3': 3,
        'PHASE4': 4,
        'NA': null,
    };
    // Take highest phase in array
    let maxPhase = null;
    for (const p of phases) {
        const v = phaseMap[p];
        if (v != null) maxPhase = maxPhase == null ? v : Math.max(maxPhase, v);
    }
    return maxPhase;
}

/**
 * Normalize raw ClinicalTrials.gov study record → Sciweon Trial schema.
 */
export function normalize(raw, compoundIdHint = null) {
    if (!raw) return null;
    const protocol = raw.protocolSection ?? {};
    const idMod = protocol.identificationModule ?? {};
    const statusMod = protocol.statusModule ?? {};
    const designMod = protocol.designModule ?? {};
    const conditionsMod = protocol.conditionsModule ?? {};
    const armsMod = protocol.armsInterventionsModule ?? {};
    const sponsorMod = protocol.sponsorCollaboratorsModule ?? {};
    const referencesMod = protocol.referencesModule ?? {};

    const nctId = idMod.nctId;
    if (!nctId || !/^NCT\d{8}$/.test(nctId)) return null;

    const status = statusMod.overallStatus ?? 'UNKNOWN';
    const isNegative = ['TERMINATED', 'WITHDRAWN', 'SUSPENDED'].includes(status);

    const interventions = (armsMod.interventions ?? []).map(i => ({
        name: i.name ?? '',
        compound_id: compoundIdHint, // V0.1: pass-through hint, future: real NLP match
        mapping_confidence: compoundIdHint ? 60 : null, // intervention name match is fuzzy
        type: i.type ?? 'OTHER',
    })).filter(i => i.name);

    const timestamp = new Date().toISOString();
    const enrollmentInfo = designMod.enrollmentInfo ?? {};

    return {
        id: `sciweon::trial::${nctId}`,
        nct_id: nctId,
        status,
        status_reason: statusMod.whyStopped ?? null,
        is_negative_outcome: isNegative,
        phase: normalizePhase(designMod.phases),
        conditions: (conditionsMod.conditions ?? []).slice(0, 100),
        interventions,
        enrollment: {
            target: enrollmentInfo.count ?? null,
            actual: null,
            type: enrollmentInfo.type ?? null,
        },
        dates: {
            start: statusMod.startDateStruct?.date ?? null,
            completion: statusMod.completionDateStruct?.date ?? null,
            primary_completion: statusMod.primaryCompletionDateStruct?.date ?? null,
        },
        sponsor: sponsorMod.leadSponsor?.name ?? null,
        references: (referencesMod.references ?? [])
            .filter(r => r.pmid && /^\d+$/.test(String(r.pmid)))
            .slice(0, 200)
            .map(r => ({
                pmid: String(r.pmid),
                type: r.type ?? null,
                citation: r.citation ? String(r.citation).slice(0, 2000) : null,
            })),
        provenance: {
            sources: [{
                source: 'clinicaltrials',
                source_id: nctId,
                timestamp,
                extraction_method: 'ct_gov_v2_api',
            }],
            last_updated: timestamp,
        },
        // V0.5.1: Sciweon Principle 5 — single-source ≤60, quantified at extraction
        confidence: {
            overall: scoreDataPoint(['clinicaltrials']),
            method: 'cross_source_consensus_v2',
            cross_source_agreement: { structural_match: false, conflicts: [] },
        },
    };
}
