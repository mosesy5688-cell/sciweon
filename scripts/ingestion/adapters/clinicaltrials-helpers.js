/**
 * ClinicalTrials.gov results signal extraction + fetch helpers.
 * Extracted from clinicaltrials-adapter.js to keep that file under CES 250-line limit.
 */

const REQUEST_TIMEOUT_MS = 20000;

/**
 * A fetch error carrying the HTTP status so callers can split a TERMINAL client
 * error (400 malformed/unsearchable query) from a TRANSIENT one (429/5xx/timeout).
 * `status` is the numeric HTTP status, or null for a network/timeout reject.
 */
export class CtFetchError extends Error {
    constructor(status, url) {
        super(`HTTP ${status}: ${url}`);
        this.name = 'CtFetchError';
        this.status = status;
    }
}

export async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new CtFetchError(res.status, url);
    return res.json();
}

export function extractResultsSignals(raw) {
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
