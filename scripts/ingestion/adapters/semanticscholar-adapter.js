/**
 * Semantic Scholar Adapter — Sciweon V0.2.1
 *
 * Cross-source verification for Paper entity. S2 is the 2nd paper source
 * alongside OpenAlex; both ingest the same papers from publisher metadata
 * but apply independent processing. Cross-validating raw fields (title,
 * year, citationCount) between two independent sources surfaces conflicts
 * that would otherwise be invisible.
 *
 * API docs: https://api.semanticscholar.org/api-docs/graph
 * Base: https://api.semanticscholar.org/graph/v1
 *
 * PRIMARY-DATA contract (feedback_no_secondary_processed_data):
 *   Consumed fields (raw / objective / source IDs):
 *     - paperId, externalIds.{DOI,PubMed,ArXiv}
 *     - title, abstract  (paper-authored text)
 *     - authors[].name   (paper byline)
 *     - citationCount    (objective count)
 *     - year, publicationDate
 *     - openAccessPdf    (derive is_open_access boolean)
 *     - venue            (publisher-supplied journal/conference name)
 *
 *   Intentionally NOT consumed (S2 secondary processing):
 *     - fieldsOfStudy / s2FieldsOfStudy  (ML topic classification)
 *     - tldr                              (SPECTER-model AI summary)
 *     - influentialCitationCount          (S2 proprietary ranking)
 *
 *   V0.4 may add Sciweon-computed equivalents (e.g. our own topic
 *   classifier over abstract + MeSH primary signal).
 */

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_DELAY_MS = 200; // anonymous polite pool
const BATCH_MAX = 500;        // S2 batch endpoint limit

// Fields explicitly listed — anything not listed is NOT requested, so we
// cannot accidentally start consuming a secondary field later.
const PRIMARY_FIELDS = [
    'paperId',
    'externalIds',
    'title',
    'abstract',
    'authors.name',
    'authors.externalIds',
    'citationCount',
    'year',
    'publicationDate',
    'openAccessPdf',
    'venue',
].join(',');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildHeaders() {
    const h = { 'Accept': 'application/json' };
    if (process.env.S2_API_KEY) h['x-api-key'] = process.env.S2_API_KEY;
    return h;
}

async function fetchJson(url, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: { ...buildHeaders(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        if (res.status === 429 || res.status === 403) {
            // Rate limited — wait and retry once
            await sleep(5000);
            const retry = await fetch(url, {
                ...init,
                headers: { ...buildHeaders(), ...(init.headers ?? {}) },
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
 * Batch lookup by DOI. Returns Map<doi_lowercase, raw_s2_paper>.
 * S2 batch endpoint accepts up to 500 IDs per request.
 */
export async function fetchByDoiBatch(dois) {
    if (!dois?.length) return new Map();
    const result = new Map();
    for (let i = 0; i < dois.length; i += BATCH_MAX) {
        const chunk = dois.slice(i, i + BATCH_MAX);
        const ids = chunk.map(d => `DOI:${d}`);
        try {
            const url = `${S2_BASE}/paper/batch?fields=${PRIMARY_FIELDS}`;
            const data = await fetchJson(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            });
            if (Array.isArray(data)) {
                for (let j = 0; j < data.length; j++) {
                    const paper = data[j];
                    if (paper && paper.paperId) {
                        const doi = chunk[j].toLowerCase();
                        result.set(doi, paper);
                    }
                }
            }
        } catch (e) {
            console.warn(`[S2] batch ${i}-${i + chunk.length}: ${e.message}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }
    return result;
}

/**
 * Extract PRIMARY-ONLY fields from an S2 paper record.
 * Returns a partial Paper-shaped object suitable for merging into an
 * OpenAlex-normalized Paper entity.
 */
export function extractPrimary(raw) {
    if (!raw || !raw.paperId) return null;
    const ext = raw.externalIds ?? {};
    const doi = ext.DOI ? String(ext.DOI).toLowerCase() : null;
    const pmid = ext.PubMed ? String(ext.PubMed) : null;
    const arxivId = ext.ArXiv ? String(ext.ArXiv) : null;

    return {
        s2_paper_id: raw.paperId,
        doi,
        pmid,
        arxiv_id: arxivId,
        title: raw.title ?? null,
        abstract: raw.abstract ?? null,
        authors: (raw.authors ?? []).slice(0, 1000).map(a => ({
            name: a.name ?? '',
            raw_affiliations: [], // S2 does not expose raw affiliation strings
        })).filter(a => a.name),
        citation_count: typeof raw.citationCount === 'number' ? raw.citationCount : null,
        publication_year: typeof raw.year === 'number' ? raw.year : null,
        publication_date: raw.publicationDate ?? null,
        is_open_access: raw.openAccessPdf?.url ? true : null,
        venue: raw.venue ?? null,
    };
}

/**
 * Cross-source consistency check between an OpenAlex Paper and the
 * S2 record. Returns { match: boolean, conflicts: string[] }.
 */
export function compareWithOpenAlex(paper, s2Primary) {
    const conflicts = [];
    if (!paper || !s2Primary) return { match: false, conflicts: ['no_s2_match'] };

    // Title: case-insensitive prefix match (titles often have minor punctuation differences)
    const tA = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    const tB = (s2Primary.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (tA && tB && tA !== tB) conflicts.push('title_mismatch');

    // Year
    if (paper.publication_year != null && s2Primary.publication_year != null
        && paper.publication_year !== s2Primary.publication_year) {
        conflicts.push('year_mismatch');
    }

    // Citation count divergence > 30% suggests indexing lag, not a fact conflict
    if (paper.citation_count > 0 && s2Primary.citation_count > 0) {
        const ratio = Math.abs(paper.citation_count - s2Primary.citation_count)
            / Math.max(paper.citation_count, s2Primary.citation_count);
        if (ratio > 0.5) conflicts.push('citation_count_divergence');
    }

    return { match: true, conflicts };
}
