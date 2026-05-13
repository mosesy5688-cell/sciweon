/**
 * Simulator checks — paper / retraction / provenance domain.
 * Each function takes (compound, ctx) where ctx = { indices, data, findings, expect }
 * and mutates ctx.findings.
 */

function getPapers(c, indices) {
    const pids = indices.papersByCompound.get(c.id) || [];
    return pids.map(id => indices.paperById.get(id)).filter(Boolean);
}

// ─── Paper coverage / quality checks ───
export const paperCoverageChecks = {
    paper_count(c, { indices, findings }) {
        const papers = getPapers(c, indices);
        if (papers.length === 0) { findings.gaps.push('No papers linked to compound'); return; }
        findings.evidence.paper_count = papers.length;
    },
    citation_counts(c, { indices, findings }) {
        const papers = getPapers(c, indices);
        if (papers.length === 0) return;
        const n = papers.filter(p => p.citation_count > 0).length;
        if (n / papers.length < 0.3)
            findings.gaps.push(`Only ${n}/${papers.length} papers have citation data`);
    },
    mesh_terms(c, { indices, findings }) {
        const papers = getPapers(c, indices);
        if (papers.length === 0) return;
        const n = papers.filter(p => p.mesh_terms?.length > 0).length;
        if (n / papers.length < 0.3)
            findings.gaps.push(`Only ${n}/${papers.length} papers have MeSH terms — limits topical filtering`);
    },
    recent_papers(c, { indices, findings }) {
        const papers = getPapers(c, indices);
        if (papers.length === 0) return;
        const recent = papers.filter(p => p.publication_year >= 2020).length;
        if (recent === 0) findings.gaps.push('No papers from 2020+ — Agent gets stale evidence');
    },
    open_access_flag(c, { indices, findings }) {
        const papers = getPapers(c, indices);
        if (papers.length === 0) return;
        const oa = papers.filter(p => p.is_open_access === true).length;
        if (oa / papers.length < 0.2)
            findings.gaps.push(`Only ${oa}/${papers.length} papers are Open Access — limits Agent fact verification`);
    },
    doi_traceability(c, { indices, findings }) {
        const papers = getPapers(c, indices);
        if (papers.length === 0) return;
        const withDoi = papers.filter(p => p.doi).length;
        if (withDoi / papers.length < 0.5)
            findings.gaps.push(`Only ${withDoi}/${papers.length} papers have DOI — limits source traceability`);
    },
};

// ─── Retraction checks (primary facts only — V0.1 contract) ───
export const retractionChecks = {
    retraction_detection(c, { indices, data, findings }) {
        const papers = getPapers(c, indices);
        const retracted = papers.filter(p => p.is_retracted).length;
        const anyRwChecked = papers.some(p => p.retraction_source === 'crossref_retraction_watch')
            || data.retractionIndexAvailable === true;
        findings.evidence.retraction = { papers: papers.length, retracted, rw_checked: anyRwChecked };
        if (!anyRwChecked && papers.length > 50)
            findings.gaps.push('Retraction status not cross-validated against canonical source (Retraction Watch)');
    },
    retraction_doi_proof(c, { indices, findings }) {
        // Each retracted paper must carry the canonical publisher-issued
        // retraction notice DOI (primary fact + V0.4 NLP entry point).
        const retracted = getPapers(c, indices).filter(p => p.is_retracted);
        if (retracted.length === 0) return;
        const withDoi = retracted.filter(p => p.retraction_doi).length;
        if (withDoi < retracted.length)
            findings.gaps.push(`${retracted.length - withDoi}/${retracted.length} retractions lack retraction_doi (primary fact missing)`);
    },
    retraction_source_provenance(c, { indices, findings }) {
        const retracted = getPapers(c, indices).filter(p => p.is_retracted);
        if (retracted.length === 0) return;
        const withSource = retracted.filter(p => p.retraction_source).length;
        if (withSource < retracted.length)
            findings.gaps.push(`${retracted.length - withSource}/${retracted.length} retractions lack retraction_source provenance`);
    },
};

// ─── Cross-link checks (paper ↔ trial) ───
function paperToTrialLinks(c, { indices, findings }) {
    const papers = getPapers(c, indices);
    if (papers.length === 0) return;
    const linked = papers.filter(p => p.mentioned_trial_ids?.length > 0).length;
    if (linked === 0) findings.gaps.push('No paper-to-trial NCT cross-mentions detected');
}

export const crossLinkChecks = {
    paper_to_trial_links: paperToTrialLinks,
    trial_to_paper_links: paperToTrialLinks, // bidirectional view of the same signal
};

// ─── Confidence / provenance checks ───
export const provenanceChecks = {
    overall_confidence(c, { findings }) {
        if (c.confidence?.overall == null) findings.gaps.push('No overall confidence');
    },
    per_dimension_confidence(c, { findings }) {
        if (c.confidence?.structural == null || c.confidence?.bioactivity == null)
            findings.gaps.push('Missing per-dimension confidence breakdown');
    },
    source_count(c, { findings }) {
        const n = c.provenance?.sources?.length || 0;
        if (n < 2) findings.gaps.push(`Only ${n} source(s) — Agent cannot cross-validate`);
    },
    structural_match_flag(c, { findings }) {
        if (c.confidence?.cross_source_agreement?.structural_match == null)
            findings.gaps.push('No structural_match flag — Agent cannot tell if sources agree');
    },
    source_list_per_field(c, { findings }) {
        if (!c.provenance?.sources || c.provenance.sources.length === 0)
            findings.gaps.push('No provenance.sources array');
    },
    timestamp_per_extraction(c, { findings }) {
        if (!c.provenance?.sources?.every(s => s.timestamp))
            findings.gaps.push('Missing extraction timestamps in provenance');
    },
    extraction_method_visible(c, { findings }) {
        if (!c.provenance?.sources?.every(s => s.extraction_method))
            findings.gaps.push('Missing extraction_method in provenance');
    },
};
