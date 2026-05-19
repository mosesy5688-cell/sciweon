/**
 * PubMed E-utilities Adapter — Sciweon V0.2.3
 *
 * Paper 3rd source (after OpenAlex + S2). PubMed is the NIH NCBI canonical
 * biomedical literature index — same parent institution as ClinicalTrials.gov
 * and PubChem. Critical signal: PubMed pubtype[] field tags retracted papers
 * in real-time (faster than Retraction Watch), providing a second
 * independent retraction source.
 *
 * API docs: https://www.ncbi.nlm.nih.gov/books/NBK25497/
 * Base: https://eutils.ncbi.nlm.nih.gov/entrez/eutils
 *
 * PRIMARY-DATA contract (primary-data-only policy):
 *   Consumed (raw NCBI-indexed publisher metadata):
 *     - uid (PMID) — international biomedical paper ID
 *     - source (journal name — publisher-supplied)
 *     - pubdate / epubdate / sortpubdate
 *     - title (raw publisher metadata)
 *     - pubtype[] — international publication type vocabulary (NIH
 *       authoritative classification, parallel to NIH MEDLINE MeSH terms)
 *     - articleids[] — DOI / PMC IDs (international identifiers)
 *
 *   Derived (Sciweon-computed from pubtype):
 *     - is_retracted_pubmed: pubtype contains "Retracted Publication"
 *     - is_retraction_notice: pubtype contains "Retraction Notice"
 *
 *   Authoritative example (per the principle's "exception" clause):
 *     PubMed pubtype is NIH MEDLINE's controlled vocabulary, same authority
 *     class as MeSH terms. International standard, transmitted from
 *     publishers and curated by NIH MEDLINE indexers.
 *
 *   NOT consumed:
 *     - elocationid free-form  (use parsed DOI from articleids instead)
 *     - history fields  (NCBI internal indexing timeline)
 */

import {
    shouldFetchNextPage, nextSinceTokenAfterLoop,
} from '../../factory/lib/pagination-control.js';

// V2 adapter contract: real incremental via NCBI esearch date filter.
export const supportsIncremental = true;
export const fallbackFullRefreshDays = 7;

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_DELAY_MS = 350;  // NCBI polite: <=3 req/sec without API key
const BATCH_MAX = 200;          // NCBI esummary batch size guideline

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildUrl(path, params) {
    const q = new URLSearchParams(params);
    if (process.env.NCBI_API_KEY) q.set('api_key', process.env.NCBI_API_KEY);
    if (process.env.NCBI_EMAIL) q.set('email', process.env.NCBI_EMAIL);
    q.set('tool', 'sciweon');
    return `${EUTILS_BASE}/${path}?${q.toString()}`;
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
            await sleep(5000);
            const retry = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!retry.ok) throw new Error(`HTTP ${retry.status}: ${url}`);
            return retry.json();
        }
        throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return res.json();
}

/**
 * Batch fetch PubMed esummary records. Returns Map<pmid_string, raw_record>.
 * Splits requests into BATCH_MAX-sized chunks; one HTTP call per chunk.
 */
export async function fetchByPmidBatch(pmids) {
    if (!pmids?.length) return new Map();
    const unique = [...new Set(pmids.filter(p => /^\d+$/.test(String(p))))];
    const result = new Map();
    for (let i = 0; i < unique.length; i += BATCH_MAX) {
        const chunk = unique.slice(i, i + BATCH_MAX);
        const url = buildUrl('esummary.fcgi', {
            db: 'pubmed',
            id: chunk.join(','),
            retmode: 'json',
        });
        try {
            const data = await fetchJson(url);
            const r = data?.result;
            if (r && Array.isArray(r.uids)) {
                for (const pmid of r.uids) {
                    if (r[pmid] && !r[pmid].error) result.set(pmid, r[pmid]);
                }
            }
        } catch (e) {
            console.warn(`[PUBMED] batch ${i}-${i + chunk.length}: ${e.message}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }
    return result;
}

function findArticleId(articleids, idtype) {
    if (!Array.isArray(articleids)) return null;
    const hit = articleids.find(a => a.idtype === idtype);
    return hit?.value ?? null;
}

/**
 * Extract PRIMARY-ONLY fields from a raw PubMed esummary record.
 * Returns a partial Paper-shaped object suitable for merging into an
 * OpenAlex+S2 normalized Paper entity.
 */
export function extractPrimary(raw) {
    if (!raw || !raw.uid) return null;
    const pubtype = Array.isArray(raw.pubtype) ? raw.pubtype : [];
    const doi = findArticleId(raw.articleids, 'doi');
    const pmcid = findArticleId(raw.articleids, 'pmc');
    return {
        pmid: String(raw.uid),
        doi: doi ? doi.toLowerCase() : null,
        pmcid,
        title: raw.title ?? null,
        venue: raw.source ?? null,
        publication_date: raw.sortpubdate ?? raw.pubdate ?? null,
        pubtype,
        is_retracted_pubmed: pubtype.includes('Retracted Publication'),
        is_retraction_notice: pubtype.includes('Retraction Notice'),
    };
}

/**
 * Cross-source consistency check: compare PubMed retraction signal
 * with an already-computed retraction state from Retraction Watch.
 * Returns { agree: boolean, conflicts: string[] }.
 */
export function compareRetraction(paper, pubmedPrimary) {
    const conflicts = [];
    if (!paper || !pubmedPrimary) return { agree: false, conflicts: ['no_pubmed_match'] };
    const rwSays = paper.is_retracted === true;
    const pmSays = pubmedPrimary.is_retracted_pubmed === true;
    if (rwSays !== pmSays) {
        if (pmSays && !rwSays) conflicts.push('pubmed_says_retracted_rw_says_not');
        else if (rwSays && !pmSays) conflicts.push('rw_says_retracted_pubmed_says_not');
    }
    return { agree: conflicts.length === 0, conflicts };
}

// ── V2 incremental interface ──────────────────────────────────────────────────

function todayYmd() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '/');
}

function sinceYmd(sinceToken) {
    const d = sinceToken
        ? new Date(sinceToken)
        : (() => { const t = new Date(); t.setDate(t.getDate() - 7); return t; })();
    return d.toISOString().slice(0, 10).replace(/-/g, '/');
}

/**
 * Check how many papers were added/updated in PubMed since sinceToken (YYYY-MM-DD).
 * Uses esearch with datetype=pdat (publication date).
 */
export async function checkForUpdates(sinceToken) {
    const since = sinceYmd(sinceToken);
    const today = todayYmd();
    const url = buildUrl('esearch.fcgi', {
        db: 'pubmed',
        datetype: 'pdat',
        mindate: since,
        maxdate: today,
        retmax: '0',
        retmode: 'json',
    });
    try {
        const data = await fetchJson(url);
        const count = parseInt(data?.esearchresult?.count ?? '0', 10);
        return { hasUpdates: count > 0, count, nextSinceToken: today.replace(/\//g, '-') };
    } catch (e) {
        console.warn(`[PUBMED] checkForUpdates: ${e.message}`);
        return { hasUpdates: false, count: 0, nextSinceToken: sinceToken };
    }
}

/**
 * Fetch papers updated since sinceToken across all pages (V0.5.7).
 * esearch with retstart offset; esummary batch handles record fetch.
 */
export async function fetchIncremental(sinceToken) {
    const since = sinceYmd(sinceToken);
    const today = todayYmd();
    const todayDash = today.replace(/\//g, '-');
    const sinceDash = since.replace(/\//g, '-');
    const allPmids = [];
    let retstart = 0;
    let total = null;
    let pagesDone = 0;
    let stopKind = 'stop_exhausted';
    while (true) {
        const searchUrl = buildUrl('esearch.fcgi', {
            db: 'pubmed', datetype: 'pdat',
            mindate: since, maxdate: today,
            retstart: String(retstart), retmax: String(BATCH_MAX),
            retmode: 'json',
        });
        let data;
        try { data = await fetchJson(searchUrl); }
        catch (e) {
            console.warn(`[PUBMED] fetchIncremental esearch page ${pagesDone + 1}: ${e.message}`);
            break;
        }
        const ids = data?.esearchresult?.idlist ?? [];
        allPmids.push(...ids);
        if (total === null) total = parseInt(data?.esearchresult?.count ?? '0', 10);
        pagesDone++;
        retstart += BATCH_MAX;
        const decision = shouldFetchNextPage({
            recordsFetched: allPmids.length,
            pagesDone,
            hasMoreSignal: retstart < total && ids.length > 0,
        });
        if (decision.kind !== 'continue') { stopKind = decision.kind; break; }
        await sleep(REQUEST_DELAY_MS);
    }
    if (stopKind !== 'stop_exhausted') {
        console.warn(`[PUBMED] fetchIncremental ${stopKind} after ${pagesDone} pages / ${allPmids.length} pmids — holding cursor at ${sinceDash}`);
    }
    const nextSinceToken = nextSinceTokenAfterLoop({ stopKind, sinceToken: sinceDash, today: todayDash });
    if (!allPmids.length) return { records: [], nextSinceToken };
    await sleep(REQUEST_DELAY_MS);
    const rawMap = await fetchByPmidBatch(allPmids);
    const records = [];
    for (const raw of rawMap.values()) {
        const p = extractPrimary(raw);
        if (p) records.push({ id: `sciweon::paper::pubmed::${p.pmid}`, source: 'pubmed', ...p });
    }
    return { records, nextSinceToken };
}
