/**
 * ClinicalTrials.gov Adapter V2 — Sciweon DataSourceAdapterV2 interface (§11.2).
 *
 * sinceToken: YYYY-MM-DD (LastUpdatePostDate filter). null = today − 7 days.
 * Incremental fetches recently updated studies and normalizes to Sciweon Trial schema.
 * V1 functions (searchByIntervention, fetchResultsByNctId, normalize) kept for stage-2 pipeline.
 *
 * API docs: https://clinicaltrials.gov/data-api/api
 */

import { scoreDataPoint } from '../../factory/lib/confidence-scorer.js';
import { extractResultsSignals, fetchJson } from './clinicaltrials-helpers.js';
import {
    shouldFetchNextPage, nextSinceTokenAfterLoop,
} from '../../factory/lib/pagination-control.js';

// ─── V2 adapter contract ──────────────────────────────────────────────────
export const supportsIncremental     = true;
export const fallbackFullRefreshDays = 14;

const CT_BASE = 'https://clinicaltrials.gov/api/v2/studies';
const INCREMENTAL_PAGE_SIZE = 200;

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

// extractResultsSignals + fetchJson (+ CtFetchError carrying the HTTP status for the terminal-vs-transient split) live in clinicaltrials-helpers.js (CES split).

/**
 * Search trials by intervention name. Returns { ok, terminal, studies }:
 *   - ok:true                  HTTP 200 (even 0 results = a genuine empty).
 *   - ok:false, terminal:false TRANSIENT (429 / 5xx / network / timeout) -- the caller
 *                              MUST NOT stamp fresh; stays eligible + retried next wrap
 *                              (PR-B + [[cross_cycle_silent_data_loss]]).
 *   - ok:false, terminal:true  TERMINAL/unsearchable (HTTP 400 -- a malformed query.intr,
 *                              e.g. a bracketed IUPAC the Essie parser rejects). Retry is
 *                              futile, so the caller must NOT count it as a transient
 *                              error (no queryErrorCount inflate, no frozen-cursor).
 * The trial-linker skips no-searchable-name compounds BEFORE the request (see
 * trial-search-name.js); this terminal signal is the defense-in-depth so a stray 400
 * can never freeze the cursor.
 */
export async function searchByInterventionChecked(name, pageSize = 100) {
    try {
        const url = `${CT_BASE}?query.intr=${encodeURIComponent(name)}&pageSize=${pageSize}&format=json`;
        const data = await fetchJson(url);
        return { ok: true, terminal: false, studies: data?.studies ?? [] };
    } catch (e) {
        // HTTP 400 = a malformed/unsearchable query (deterministic; retry futile) -> TERMINAL.
        // Everything else (429 / 5xx / network / timeout / no-status) is a TRANSIENT outage.
        const terminal = e?.status === 400;
        console.warn(`[CT] intervention "${name}": ${e.message}${terminal ? ' (terminal/unsearchable -- not a transient failure)' : ''}`);
        return { ok: false, terminal, studies: [] };
    }
}

/** Back-compat array contract (callers that don't need the {ok} failure signal). */
export async function searchByIntervention(name, pageSize = 100) {
    const { studies } = await searchByInterventionChecked(name, pageSize);
    return studies;
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

// ─── V2 adapter functions ─────────────────────────────────────────────────

function bootstrapSince() {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
}

function buildUpdateQuery(since) {
    // ClinicalTrials.gov V2 AREA/RANGE syntax for LastUpdatePostDate
    return `AREA[LastUpdatePostDate]RANGE[${since},MAX]`;
}

export async function checkForUpdates(sinceToken) {
    const since = sinceToken ?? bootstrapSince();
    const query = encodeURIComponent(buildUpdateQuery(since));
    const url = `${CT_BASE}?query.term=${query}&countTotal=true&pageSize=1&format=json`;
    const data = await fetchJson(url);
    const count = data?.totalCount ?? 0;
    return {
        hasUpdates: count > 0,
        count,
        nextSinceToken: new Date().toISOString().slice(0, 10),
    };
}

export async function fetchIncremental(sinceToken) {
    const since = sinceToken ?? bootstrapSince();
    const query = encodeURIComponent(buildUpdateQuery(since));
    const today = new Date().toISOString().slice(0, 10);
    const records = [];
    let pageToken = null;
    let pagesDone = 0;
    let stopKind = 'stop_exhausted';
    while (true) {
        const cursor = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const url = `${CT_BASE}?query.term=${query}&pageSize=${INCREMENTAL_PAGE_SIZE}&format=json${cursor}`;
        let data;
        try { data = await fetchJson(url); }
        catch (e) { console.warn(`[CT] fetchIncremental page ${pagesDone + 1}: ${e.message}`); break; }
        const studies = data?.studies ?? [];
        for (const s of studies) {
            const norm = normalize(s);
            if (norm) records.push(norm);
        }
        pagesDone++;
        pageToken = data?.nextPageToken ?? null;
        const decision = shouldFetchNextPage({
            recordsFetched: records.length,
            pagesDone,
            hasMoreSignal: Boolean(pageToken),
        });
        if (decision.kind !== 'continue') { stopKind = decision.kind; break; }
    }
    if (stopKind !== 'stop_exhausted') {
        console.warn(`[CT] fetchIncremental ${stopKind} after ${pagesDone} pages / ${records.length} records — holding cursor at ${since}`);
    }
    return { records, nextSinceToken: nextSinceTokenAfterLoop({ stopKind, sinceToken: since, today }) };
}
