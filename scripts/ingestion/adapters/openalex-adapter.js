/**
 * OpenAlex Adapter — Sciweon V0.1
 *
 * Fetches papers from OpenAlex REST API.
 *
 * API docs: https://docs.openalex.org/api-entities/works
 * Base: https://api.openalex.org/works
 * Free, CC0 licensed, no auth required.
 *
 * Strategy:
 *   - Search by compound name → matched papers
 *   - Extract DOI, citations, MeSH (NIH primary), retraction flag (cross-validated against Retraction Watch)
 *
 * CRITICAL: is_retracted=true is the Negative Evidence signal.
 */

// V2 adapter contract: real incremental via from_updated_date filter.
export const supportsIncremental = true;
export const fallbackFullRefreshDays = 7;

import {
    normalizeDoi, normalizeOpenAlexId, extractPmid,
    extractAuthors, extractMesh, reconstructAbstract, extractNctIds,
} from './openalex-helpers.js';
import {
    shouldFetchNextPage, nextSinceTokenAfterLoop,
} from '../../factory/lib/pagination-control.js';

const OPENALEX_BASE = 'https://api.openalex.org/works';
const REQUEST_TIMEOUT_MS = 20000;
const POLITE_EMAIL = 'sciweon@example.com';

async function fetchJson(url) {
    const sep = url.includes('?') ? '&' : '?';
    const politeUrl = `${url}${sep}mailto=${encodeURIComponent(POLITE_EMAIL)}`;
    const res = await fetch(politeUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

/**
 * Search papers by query term (e.g. compound name).
 *
 * V0.1 fix: mix old (high-citation) + recent (≥2020) papers.
 * OpenAlex default sort is by citation count, which gives stale evidence.
 * Agent needs recent research, not just historical highlights.
 */
export async function search(query, perPage = 25) {
    const split = Math.ceil(perPage / 2);
    const queries = [
        // Top-cited (any year) — historical authoritative papers
        `${OPENALEX_BASE}?search=${encodeURIComponent(query)}&per-page=${split}`,
        // Recent (publication_year >= 2020) sorted by citation among recent
        `${OPENALEX_BASE}?search=${encodeURIComponent(query)}&filter=publication_year%3A%3E2019&per-page=${perPage - split}&sort=cited_by_count%3Adesc`,
    ];
    const all = [];
    const seen = new Set();
    for (const url of queries) {
        try {
            const data = await fetchJson(url);
            for (const w of (data?.results ?? [])) {
                if (!seen.has(w.id)) { seen.add(w.id); all.push(w); }
            }
        } catch (e) {
            console.warn(`[OPENALEX] search "${query}": ${e.message}`);
        }
    }
    return all;
}

/**
 * Fetch single paper by DOI.
 */
export async function fetchByDoi(doi) {
    try {
        const url = `${OPENALEX_BASE}/doi:${encodeURIComponent(doi)}`;
        return await fetchJson(url);
    } catch (e) {
        console.warn(`[OPENALEX] doi "${doi}": ${e.message}`);
        return null;
    }
}

/**
 * Batch fetch papers by PMID list (max 50 per call, OR-filter).
 * Returns array of raw OpenAlex work records.
 */
export async function fetchByPmidBatch(pmids) {
    if (!pmids?.length) return [];
    const BATCH = 50;
    const all = [];
    for (let i = 0; i < pmids.length; i += BATCH) {
        const chunk = pmids.slice(i, i + BATCH);
        const filter = `pmid:${chunk.join('|')}`;
        const url = `${OPENALEX_BASE}?filter=${encodeURIComponent(filter)}&per-page=${BATCH}`;
        try {
            const data = await fetchJson(url);
            for (const w of (data?.results ?? [])) all.push(w);
        } catch (e) {
            console.warn(`[OPENALEX] pmid batch ${i}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return all;
}

// OpenAlex `concepts` and `fields_of_study` intentionally NOT extracted —
// secondary ML output, ~50-70% accuracy. V0.4: Sciweon's own classifier.

export function normalize(raw, compoundIdHint = null, extractionMethod = 'concept_match') {
    if (!raw || !raw.id) return null;

    const openalexId = normalizeOpenAlexId(raw.id);
    const doi = normalizeDoi(raw.doi);
    const title = raw.title ?? raw.display_name ?? '';
    if (!title) return null;

    // OpenAlex inverted index → reconstruct abstract
    const abstract = raw.abstract_inverted_index
        ? reconstructAbstract(raw.abstract_inverted_index)
        : null;

    const mentionedCompounds = compoundIdHint ? [{
        compound_id: compoundIdHint,
        mention_confidence: 70, // V0.1: name-based match, medium confidence
        extraction_method: extractionMethod,
    }] : [];

    const timestamp = new Date().toISOString();

    return {
        id: `sciweon::paper::${openalexId || (doi ? `doi-${doi.replace(/[^a-zA-Z0-9.]/g, '_')}` : `untitled-${Date.now()}`)}`,
        doi,
        openalex_id: openalexId,
        s2_paper_id: null,
        pmid: extractPmid(raw),
        title: title.substring(0, 2000),
        abstract: abstract ? abstract.substring(0, 20000) : null,
        publication_date: raw.publication_date ?? null,
        publication_year: raw.publication_year ?? null,
        authors: extractAuthors(raw),
        citation_count: raw.cited_by_count ?? 0,
        is_open_access: raw.open_access?.is_oa ?? null,
        is_retracted: raw.is_retracted === true,
        retraction_doi: null,
        retraction_date: null,
        retraction_nature: null,
        retraction_source: raw.is_retracted === true ? 'openalex' : null, // overridden by Retraction Watch when matched (canonical)
        mesh_terms: extractMesh(raw),
        mentioned_compounds: mentionedCompounds,
        mentioned_trial_ids: extractNctIds(abstract),
        provenance: {
            sources: [{
                source: 'openalex',
                source_id: openalexId ?? doi ?? raw.id,
                timestamp,
                extraction_method: 'openalex_works_api',
            }],
            last_updated: timestamp,
        },
    };
}

function sinceDefault() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
}

/**
 * Check if OpenAlex has works updated since sinceToken (YYYY-MM-DD).
 * Uses from_updated_date filter with per-page=1.
 */
export async function checkForUpdates(sinceToken) {
    const since = sinceToken ?? sinceDefault();
    const today = new Date().toISOString().slice(0, 10);
    try {
        const data = await fetchJson(`${OPENALEX_BASE}?filter=from_updated_date:${since}&per-page=1`);
        const count = data?.meta?.count ?? 0;
        return { hasUpdates: count > 0, count, nextSinceToken: today };
    } catch (e) {
        console.warn(`[OPENALEX] checkForUpdates: ${e.message}`);
        return { hasUpdates: false, count: 0, nextSinceToken: sinceToken };
    }
}

/**
 * Fetch works updated since sinceToken across all pages (V0.5.7).
 * OpenAlex uses cursor pagination — `cursor=*` first call, then
 * `meta.next_cursor` until null. Caps via shared pagination-control.
 */
export async function fetchIncremental(sinceToken) {
    const since = sinceToken ?? sinceDefault();
    const today = new Date().toISOString().slice(0, 10);
    const PAGE_SIZE = 200;
    const records = [];
    let cursor = '*';
    let pagesDone = 0;
    let stopKind = 'stop_exhausted';
    while (true) {
        let data;
        try {
            data = await fetchJson(
                `${OPENALEX_BASE}?filter=from_updated_date:${since}&per-page=${PAGE_SIZE}&sort=updated_date:asc&cursor=${encodeURIComponent(cursor)}`,
            );
        } catch (e) {
            console.warn(`[OPENALEX] fetchIncremental page ${pagesDone + 1}: ${e.message}`);
            break;
        }
        const rows = data?.results ?? [];
        for (const r of rows) {
            const norm = normalize(r);
            if (norm) records.push(norm);
        }
        pagesDone++;
        const next = data?.meta?.next_cursor ?? null;
        const decision = shouldFetchNextPage({
            recordsFetched: records.length,
            pagesDone,
            hasMoreSignal: Boolean(next),
        });
        if (decision.kind !== 'continue') { stopKind = decision.kind; break; }
        cursor = next;
    }
    if (stopKind !== 'stop_exhausted') {
        console.warn(`[OPENALEX] fetchIncremental ${stopKind} after ${pagesDone} pages / ${records.length} records — holding cursor at ${since}`);
    }
    return { records, nextSinceToken: nextSinceTokenAfterLoop({ stopKind, sinceToken: since, today }) };
}
