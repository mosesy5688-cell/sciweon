/**
 * OpenAlex Adapter Helpers — field extractors extracted for CES compliance.
 */

// PRIMARY-DATA: OpenAlex doi raw field occasionally contains placeholder values.
// Validate after URL prefix strip; return null on failure (prevents schema REJECT halt).
export const DOI_PATTERN = /^10\.\d{4,}\/\S+$/;

export function normalizeDoi(raw) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').toLowerCase();
    if (!s) return null;
    return DOI_PATTERN.test(s) ? s : null;
}

export function normalizeOpenAlexId(idUrl) {
    if (!idUrl) return null;
    const match = idUrl.match(/W\d+/);
    return match ? match[0] : null;
}

export function extractPmid(raw) {
    const ids = raw.ids ?? {};
    const pmidUrl = ids.pmid ?? null;
    if (!pmidUrl) return null;
    const m = String(pmidUrl).match(/(\d+)$/);
    return m ? m[1] : null;
}

export function extractAuthors(raw) {
    // PRIMARY-DATA: keep paper byline + affiliation text only.
    // OpenAlex normalized author.display_name is secondary entity-resolution output.
    const authorships = raw.authorships ?? [];
    return authorships.slice(0, 1000).map(a => ({
        name: a.raw_author_name ?? a.author?.display_name ?? '',
        raw_affiliations: (a.raw_affiliation_strings ?? []).slice(0, 20).filter(Boolean),
    })).filter(a => a.name);
}

export function extractMesh(raw) {
    // NIH MEDLINE MeSH — primary human-curated. Accept.
    return (raw.mesh ?? []).slice(0, 100).map(m => m.descriptor_name).filter(Boolean);
}

export function reconstructAbstract(inverted) {
    if (!inverted || typeof inverted !== 'object') return null;
    const words = [];
    for (const [word, positions] of Object.entries(inverted)) {
        for (const pos of positions) words[pos] = word;
    }
    return words.filter(Boolean).join(' ').trim();
}

export function extractNctIds(text) {
    if (!text) return [];
    const matches = text.match(/NCT\d{8}/g);
    return matches ? [...new Set(matches)] : [];
}
