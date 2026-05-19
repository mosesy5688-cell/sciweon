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
 * PRIMARY-DATA contract (primary-data-only policy):
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

// V2 adapter contract: real incremental via decisionDate cursor.
export const supportsIncremental = true;
export const fallbackFullRefreshDays = 14;

import {
    TERMINATED_STATUSES, normalizePhase, normalizeStatus,
} from './ctis-helpers.js';
import {
    shouldFetchNextPage, nextSinceTokenAfterLoop,
} from '../../factory/lib/pagination-control.js';

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

function sinceDefault() {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return d.toISOString().slice(0, 10);
}

/**
 * Check if any CTIS trials have a decisionDate >= sinceToken (YYYY-MM-DD).
 */
export async function checkForUpdates(sinceToken) {
    const since = sinceToken ?? sinceDefault();
    const today = new Date().toISOString().slice(0, 10);
    try {
        const data = await fetchJson(`${CTIS_BASE}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pagination: { page: 1, size: 1 },
                searchCriteria: { decisionDateFrom: since },
                sort: { property: 'decisionDate', direction: 'DESC' },
            }),
        });
        const count = data?.totalNumberOfResults ?? (Array.isArray(data?.data) && data.data.length > 0 ? 1 : 0);
        return { hasUpdates: count > 0, count, nextSinceToken: today };
    } catch (e) {
        console.warn(`[CTIS] checkForUpdates: ${e.message}`);
        return { hasUpdates: false, count: 0, nextSinceToken: sinceToken };
    }
}

/**
 * Fetch CTIS trials updated since sinceToken across all pages (V0.5.7).
 * Returns normalized Trial records. Pagination via POST body page/size;
 * cursor holds at sinceToken if cap aborts before exhaustion.
 */
export async function fetchIncremental(sinceToken) {
    const since = sinceToken ?? sinceDefault();
    const today = new Date().toISOString().slice(0, 10);
    const PAGE_SIZE = 100; // CTIS max accepted page size
    const records = [];
    let page = 1;
    let totalAvailable = null;
    let stopKind = 'stop_exhausted';
    while (true) {
        let data;
        try {
            data = await fetchJson(`${CTIS_BASE}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pagination: { page, size: PAGE_SIZE },
                    searchCriteria: { decisionDateFrom: since },
                    sort: { property: 'decisionDate', direction: 'ASC' },
                }),
            });
        } catch (e) {
            console.warn(`[CTIS] fetchIncremental page ${page}: ${e.message}`);
            break;
        }
        const rows = Array.isArray(data?.data) ? data.data : [];
        for (const r of rows) {
            const norm = normalizeToTrial(r);
            if (norm) records.push(norm);
        }
        if (totalAvailable === null && typeof data?.totalNumberOfResults === 'number') {
            totalAvailable = data.totalNumberOfResults;
        }
        const hasMore = totalAvailable !== null
            ? page * PAGE_SIZE < totalAvailable
            : rows.length === PAGE_SIZE;
        const decision = shouldFetchNextPage({
            recordsFetched: records.length,
            pagesDone: page,
            hasMoreSignal: hasMore,
        });
        if (decision.kind !== 'continue') { stopKind = decision.kind; break; }
        page++;
        await sleep(REQUEST_DELAY_MS);
    }
    if (stopKind !== 'stop_exhausted') {
        console.warn(`[CTIS] fetchIncremental ${stopKind} after ${page} pages / ${records.length} records — holding cursor at ${since}`);
    }
    return { records, nextSinceToken: nextSinceTokenAfterLoop({ stopKind, sinceToken: since, today }) };
}
