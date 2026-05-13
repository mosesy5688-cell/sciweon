/**
 * EU CTIS (Clinical Trials Information System) Adapter — Sciweon V0.3.4
 *
 * Trial 2nd source (after CT.gov). EMA's new EU Clinical Trial Information
 * System replaces EudraCT for trials approved after 2022-01-31. CTIS data
 * is independent from CT.gov — many EU-only trials never registered on
 * CT.gov, and CTIS is the canonical EMA-side source.
 *
 * API docs: https://euclinicaltrials.eu/ctis-public-api/
 * Base: https://euclinicaltrials.eu/ctis-public-api
 *
 * PRIMARY-DATA contract (feedback_no_secondary_processed_data):
 *   Consumed (EMA-supplied trial protocol data):
 *     - ctNumber       (CTIS canonical trial ID, e.g. 2022-501031-30-00)
 *     - ctStatus       (EMA-defined enum: AUTHORISED / ONGOING / ENDED / etc)
 *     - ctTitle / shortTitle / ctPublicTitle
 *     - conditions     (medical conditions, raw text)
 *     - trialCountries (EU member state codes)
 *     - decisionDate / decisionDateOverall
 *     - sponsor / sponsorType
 *     - trialPhase     (EMA phase enum)
 *     - product        (drug names + product types, raw text)
 *     - totalNumberEnrolled
 *     - primaryEndPoint / endPoint (study endpoint definitions)
 *     - ageGroup / gender / trialRegion
 *
 *   CTIS does not impose ML classification on top of trial protocol data;
 *   most fields are EMA-controlled vocabulary (parallel to CT.gov enums) or
 *   raw sponsor-submitted text.
 */

const CTIS_BASE = 'https://euclinicaltrials.eu/ctis-public-api';
const REQUEST_TIMEOUT_MS = 25000;
const REQUEST_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: { 'Accept': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
            await sleep(5000);
            const retry = await fetch(url, {
                ...init,
                headers: { 'Accept': 'application/json', ...(init.headers ?? {}) },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!retry.ok) throw new Error(`HTTP ${retry.status}: ${url}`);
            return retry.json();
        }
        if (res.status === 404) return null;
        throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return res.json();
}

/**
 * Search CTIS by free-text criteria (drug name / sponsor / condition).
 * Returns array of summary records.
 */
export async function searchByQuery(query, limit = 50) {
    if (!query) return [];
    const body = {
        pagination: { page: 1, size: Math.min(limit, 100) },
        searchCriteria: { containAll: query },
        sort: { property: 'decisionDate', direction: 'DESC' },
    };
    try {
        const data = await fetchJson(`${CTIS_BASE}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return Array.isArray(data?.data) ? data.data : [];
    } catch (e) {
        console.warn(`[CTIS] search "${query}": ${e.message}`);
        return [];
    }
}

/**
 * Fetch full trial detail by CTIS canonical ctNumber.
 */
export async function fetchByCtNumber(ctNumber) {
    if (!ctNumber) return null;
    try {
        return await fetchJson(`${CTIS_BASE}/retrieve/${encodeURIComponent(ctNumber)}`);
    } catch (e) {
        console.warn(`[CTIS] retrieve ${ctNumber}: ${e.message}`);
        return null;
    }
}

const PHASE_NORMALIZE = {
    'Phase 1': 1, 'Phase I': 1,
    'Phase 2': 2, 'Phase II': 2,
    'Phase 3': 3, 'Phase III': 3,
    'Phase 4': 4, 'Phase IV': 4,
};

function normalizePhase(rawPhase) {
    if (rawPhase == null) return null;
    const s = String(rawPhase);
    for (const [k, v] of Object.entries(PHASE_NORMALIZE)) {
        if (s.includes(k)) return v;
    }
    return null;
}

const TERMINATED_STATUSES = new Set(['ENDED_PREMATURELY', 'TERMINATED', 'HALTED', 'CANCELLED', 'WITHDRAWN']);

// CTIS /search endpoint returns ctStatus as a numeric lifecycle code while
// /retrieve returns a string. The numeric codes map to the same coarse-grained
// string status set verified empirically against representative trials:
//   codes 2/3/4/5 -> "Authorised"  (different lifecycle sub-phases, all approved)
//   code 6        -> "Halted"
//   code 8        -> "Ended"       (normal completion)
//   code 11       -> "Not authorised"
const SEARCH_STATUS_CODE_MAP = {
    2: 'AUTHORISED',
    3: 'AUTHORISED',
    4: 'AUTHORISED',
    5: 'AUTHORISED',
    6: 'HALTED',
    8: 'ENDED',
    11: 'NOT_YET_AUTHORISED',
};

const RETRIEVE_STATUS_STRING_MAP = {
    'Authorised': 'AUTHORISED',
    'Under evaluation': 'UNDER_EVALUATION',
    'Ongoing': 'ONGOING',
    'Ended': 'ENDED',
    'Ended prematurely': 'ENDED_PREMATURELY',
    'Halted': 'HALTED',
    'Cancelled': 'CANCELLED',
    'Not authorised': 'NOT_YET_AUTHORISED',
};

function normalizeStatus(rawStatus) {
    if (typeof rawStatus === 'number') return SEARCH_STATUS_CODE_MAP[rawStatus] ?? 'UNKNOWN';
    if (typeof rawStatus === 'string') return RETRIEVE_STATUS_STRING_MAP[rawStatus] ?? 'UNKNOWN';
    return 'UNKNOWN';
}

/**
 * Normalize a CTIS summary record to Sciweon Trial schema fields.
 * Note: CTIS uses ctNumber as its canonical ID; CT.gov NCT IDs are NOT
 * always present (cross-link is V0.4 enhancement via EudraCT bridging).
 */
export function normalizeToTrial(raw, compoundIdHint = null) {
    if (!raw || !raw.ctNumber) return null;
    const timestamp = new Date().toISOString();
    const status = normalizeStatus(raw.ctStatus);
    const isNegative = TERMINATED_STATUSES.has(status);
    const products = Array.isArray(raw.product) ? raw.product : (raw.product ? [raw.product] : []);
    const interventions = products.slice(0, 50).map(p => ({
        name: typeof p === 'string' ? p : (p.productName ?? p.name ?? String(p)),
        compound_id: compoundIdHint,
        mapping_confidence: compoundIdHint ? 60 : null,
        type: 'DRUG',
    })).filter(i => i.name);
    return {
        id: `sciweon::trial::${raw.ctNumber}`,
        nct_id: raw.ctNumber, // reuse nct_id slot for CTIS canonical ID
        ct_number: raw.ctNumber,
        status,
        status_reason: raw.endReason ?? null,
        is_negative_outcome: isNegative,
        phase: normalizePhase(raw.trialPhase),
        conditions: Array.isArray(raw.conditions) ? raw.conditions.slice(0, 100) : (raw.conditions ? [raw.conditions] : []),
        interventions,
        enrollment: {
            target: typeof raw.totalNumberEnrolled === 'number' ? raw.totalNumberEnrolled : null,
            actual: null,
            type: 'ESTIMATED',
        },
        dates: {
            start: raw.decisionDate ?? null,
            completion: raw.decisionDateOverall ?? null,
            primary_completion: null,
        },
        sponsor: raw.sponsor ?? null,
        references: [],
        provenance: {
            sources: [{
                source: 'ctis',
                source_id: raw.ctNumber,
                timestamp,
                extraction_method: 'ctis_public_api_v1',
            }],
            last_updated: timestamp,
        },
    };
}

export { REQUEST_DELAY_MS };
