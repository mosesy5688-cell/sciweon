/**
 * Paper-linker pure helpers (extracted from paper-linker.js for the Art 5.1
 * 250-line cap; PR-B coverage-ceiling). These are the per-paper cross-source
 * enrichment mutations -- no network, no R2 -- so they are unit-testable in
 * isolation and the linker body stays under the line cap.
 *
 * Behavior is byte-identical to the prior inline V0.1 functions (see git
 * history for the field-level rationale on each merge decision).
 */

import { lookup as lookupRetraction } from '../../ingestion/adapters/retraction-watch-adapter.js';
import { extractPrimary as s2ExtractPrimary, compareWithOpenAlex as s2Compare } from '../../ingestion/adapters/semanticscholar-adapter.js';
import { scoreEntity } from './confidence-scorer.js';

/**
 * Cross-validate one OpenAlex-normalized paper against Semantic Scholar. Mutates
 * the paper in place (fills S2 primary fields, appends s2 to provenance.sources,
 * recomputes confidence as multi-source). Returns true iff S2 enriched it.
 */
export function enrichWithS2(paper, s2Map) {
    if (!paper.doi) return false;
    const raw = s2Map.get(paper.doi.toLowerCase());
    if (!raw) return false;
    const s2Primary = s2ExtractPrimary(raw);
    if (!s2Primary) return false;

    const cmp = s2Compare(paper, s2Primary);

    if (!paper.s2_paper_id) paper.s2_paper_id = s2Primary.s2_paper_id;
    if (!paper.arxiv_id && s2Primary.arxiv_id) paper.arxiv_id = s2Primary.arxiv_id;
    if (!paper.pmid && s2Primary.pmid) paper.pmid = s2Primary.pmid;
    if (!paper.venue && s2Primary.venue) paper.venue = s2Primary.venue;
    if (paper.is_open_access == null && s2Primary.is_open_access != null) {
        paper.is_open_access = s2Primary.is_open_access;
    }

    const timestamp = new Date().toISOString();
    paper.provenance.sources.push({
        source: 's2',
        source_id: s2Primary.s2_paper_id,
        timestamp,
        extraction_method: 's2_graph_v1_batch_doi',
    });
    paper.provenance.last_updated = timestamp;

    const scored = scoreEntity({
        provenance: paper.provenance,
        confidence: { cross_source_agreement: { structural_match: cmp.conflicts.length === 0, conflicts: cmp.conflicts } },
        stats: {},
    });
    paper.confidence = {
        overall: scored.overall,
        method: scored.method,
        cross_source_agreement: { structural_match: cmp.conflicts.length === 0, conflicts: cmp.conflicts },
    };
    return true;
}

/**
 * Apply Retraction Watch PRIMARY FACTS to a normalized paper. Mutates paper in
 * place. Returns true iff a retraction was applied.
 */
export function applyRetraction(paper, rwIndex) {
    const info = lookupRetraction(paper, rwIndex);
    if (!info) return false;
    paper.is_retracted = true;
    paper.retraction_doi = info.retraction_doi || null;
    paper.retraction_date = info.retraction_date || null;
    paper.retraction_nature = info.nature || null;
    paper.retraction_source = 'crossref_retraction_watch';
    return true;
}
