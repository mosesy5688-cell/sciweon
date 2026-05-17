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

const OPENALEX_BASE = 'https://api.openalex.org/works';
const REQUEST_TIMEOUT_MS = 20000;
// OpenAlex recommends polite header for higher rate limit pool
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

function extractAuthors(raw) {
    // PRIMARY-DATA contract: keep the paper's own byline + affiliation text.
    // OpenAlex's normalized author.display_name and institution.display_name
    // are secondary entity-resolution outputs — NOT consumed here.
    // See primary-data-only policy.
    const authorships = raw.authorships ?? [];
    return authorships.slice(0, 1000).map(a => ({
        // raw_author_name = paper byline string; display_name only as fallback
        // when raw is absent (rare; ensures the entity is still listable).
        name: a.raw_author_name ?? a.author?.display_name ?? '',
        raw_affiliations: (a.raw_affiliation_strings ?? []).slice(0, 20).filter(Boolean),
    })).filter(a => a.name);
}

function extractMesh(raw) {
    // NIH MEDLINE MeSH terms — primary human-curated. Accept.
    return (raw.mesh ?? []).slice(0, 100).map(m => m.descriptor_name).filter(Boolean);
}
// OpenAlex `concepts` and `fields_of_study` intentionally NOT extracted —
// secondary ML output, ~50-70% accuracy. V0.4: Sciweon's own classifier.

/**
 * OpenAlex `id` format: "https://openalex.org/W{number}"
 * Normalize to "W{number}".
 */
function normalizeOpenAlexId(idUrl) {
    if (!idUrl) return null;
    const match = idUrl.match(/W\d+/);
    return match ? match[0] : null;
}

function extractPmid(raw) {
    const ids = raw.ids ?? {};
    const pmidUrl = ids.pmid ?? null;
    if (!pmidUrl) return null;
    const m = String(pmidUrl).match(/(\d+)$/);
    return m ? m[1] : null;
}

/**
 * Normalize raw OpenAlex work → Sciweon Paper schema.
 *
 * @param {object} raw — OpenAlex work record
 * @param {string} compoundIdHint — optional compound ID for linkage
 * @param {string} extractionMethod — how this paper was matched to compound
 */
// Sciweon Paper schema requires DOI regex `^10\.\d{4,}/\S+$`. OpenAlex
// occasionally returns DOIs that fail this pattern (e.g., raw `raw.doi`
// containing placeholders or unusually-formatted identifiers). Validate
// after URL prefix strip; return null on mismatch so downstream schema
// gate doesn't REJECT-halt the chain (caused stage-3 halt 2026-05-17,
// PR #35 fixed retraction-watch adapter; this PR fixes openalex adapter).
const DOI_PATTERN = /^10\.\d{4,}\/\S+$/;

function normalizeDoi(raw) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').toLowerCase();
    if (!s) return null;
    return DOI_PATTERN.test(s) ? s : null;
}

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

function reconstructAbstract(inverted) {
    if (!inverted || typeof inverted !== 'object') return null;
    const words = [];
    for (const [word, positions] of Object.entries(inverted)) {
        for (const pos of positions) words[pos] = word;
    }
    return words.filter(Boolean).join(' ').trim();
}

function extractNctIds(text) {
    if (!text) return [];
    const matches = text.match(/NCT\d{8}/g);
    return matches ? [...new Set(matches)] : [];
}
