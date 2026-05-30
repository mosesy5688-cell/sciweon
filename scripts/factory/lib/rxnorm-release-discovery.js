/**
 * RxNorm release URL discovery (PR-RXN-1 hotfix).
 *
 * Original probe approach scraped download.nlm.nih.gov/rxnorm/ directory
 * listing for RxNorm_full_prescribe_*.zip filenames. NLM has disabled
 * directory indexing (HTTP 403 verified 2026-05-27 via run 26504081979),
 * but direct file URLs still serve without authentication per NLM docs
 * (https://www.nlm.nih.gov/research/umls/rxnorm/docs/prescribe.html).
 *
 * Replacement strategy: NLM publishes the prescribable subset on the
 * FIRST MONDAY of each month. Compute candidate URLs for the current
 * month's first Monday + two previous months as fallback; HEAD-probe
 * each; return the first 200 OK. Handles the case where the current
 * month's release has not yet been published.
 */

import { umlsDownloadUrl } from './umls-auth.js';

// PR-RXN-2b: Full RxNorm RRF is published under the UMLS kss path (auth-gated),
// NOT the public-domain Prescribable subset's /rxnorm/ path. Discovery probes
// go through the apiKey proxy (umls-auth.js); an unauthenticated HEAD 403s.
const BASE_URL = 'https://download.nlm.nih.gov/umls/kss/rxnorm/';

/**
 * Find the first Monday of a given calendar month.
 * @param {number} year   4-digit year
 * @param {number} month  1-12
 * @returns {Date}
 */
export function firstMondayOfMonth(year, month) {
    for (let d = 1; d <= 7; d++) {
        const dt = new Date(Date.UTC(year, month - 1, d));
        if (dt.getUTCDay() === 1) return dt;
    }
    throw new Error('first Monday not found (impossible)');
}

/**
 * Format Date as MMDDYYYY string for RxNorm filename.
 */
export function formatMMDDYYYY(date) {
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    return `${mm}${dd}${yyyy}`;
}

/**
 * Format Date as YYYY-MM-DD ISO date string.
 */
export function formatIsoDate(date) {
    return date.toISOString().slice(0, 10);
}

/**
 * Build candidate URLs for first-Monday releases over the last N months,
 * newest first. now is the current Date (overrideable for testing).
 *
 * @param {number} monthsBack  how many months to consider (>=1)
 * @param {Date}   now
 * @returns {{url: string, filename: string, release_date: string}[]}
 */
export function buildCandidateUrls(monthsBack, now = new Date()) {
    if (monthsBack < 1) throw new Error('monthsBack must be >= 1');
    const out = [];
    const baseYear = now.getUTCFullYear();
    const baseMonth = now.getUTCMonth() + 1;  // 1-12
    for (let i = 0; i < monthsBack; i++) {
        let y = baseYear;
        let m = baseMonth - i;
        while (m < 1) { m += 12; y -= 1; }
        const monday = firstMondayOfMonth(y, m);
        const mmddyyyy = formatMMDDYYYY(monday);
        const filename = `RxNorm_full_${mmddyyyy}.zip`;
        out.push({
            url: BASE_URL + filename,
            filename,
            release_date: formatIsoDate(monday),
        });
    }
    return out;
}

// Auth'd Range-probe: Full RRF URLs are UMLS-gated, so probe through the apiKey
// proxy (an unauthenticated HEAD 403s). Range avoids downloading the body.
async function authRangeProbe(innerUrl) {
    const res = await fetch(umlsDownloadUrl(innerUrl), { headers: { Range: 'bytes=0-1' } });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return res;
}

/**
 * Probe candidates newest-first; return the first that responds 200/206.
 * Multi-month window = graceful rollback when the current month's Full release
 * has not yet published (NLM first-Monday releases routinely lag). Throws ONLY
 * when the entire window is empty (genuine multi-month outage) -- boundary-timing
 * drift is not a hard-fail (PR-TRIAL-ISOLATION discipline).
 *
 * @param {Array} candidates  from buildCandidateUrls
 * @param {function} headFetch  injected probe (default = auth'd Range; tests inject)
 * @returns {Promise<{url, filename, release_date, last_modified}>}
 */
export async function findLatestFullUrl(candidates, headFetch = (u) => authRangeProbe(u)) {
    const tried = [];
    for (const c of candidates) {
        let res;
        try { res = await headFetch(c.url); }
        catch (err) { tried.push(`${c.url} -> network error: ${err.message}`); continue; }
        if (res.ok) {
            return { ...c, last_modified: res.headers.get('last-modified') ?? null };
        }
        tried.push(`${c.url} -> HTTP ${res.status}`);
    }
    throw new Error(`no Full RxNorm release found in ${candidates.length} candidate(s): ${tried.join('; ')}`);
}
