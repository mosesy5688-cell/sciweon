/**
 * Confidence Scorer — Sciweon V0.1
 *
 * Cross-source consensus scoring per V8 §5.
 *
 * Formula:
 *   base = 60                            # single-source ceiling
 *   + (source_count - 1) * 10            # +10 per extra source
 *   + 20 (if structural_match)           # InChIKey matches across sources
 *   - 30 (if conflicts > 0)              # conflicts subtract
 *   + 10 (if includes pubchem)           # government data weight
 *   + 10 (if includes chembl)            # curated quality
 *   clamp [0, 100]
 */

const SOURCE_WEIGHTS = {
    pubchem: 10,
    chembl: 10,
    clinicaltrials: 5,
    openalex: 5,
    s2: 3,
};

export function scoreDataPoint(sources, options = {}) {
    const { structuralMatch = false, conflicts = [] } = options;
    if (!Array.isArray(sources) || sources.length === 0) return 0;

    let score = 60;
    score += (sources.length - 1) * 10;
    if (structuralMatch) score += 20;
    if (conflicts.length > 0) score -= 30;
    for (const s of sources) {
        const w = SOURCE_WEIGHTS[s];
        if (w) score += w;
    }
    return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreEntity(entity) {
    const sources = entity.provenance?.sources?.map(s => s.source) || [];
    const structuralMatch = entity.confidence?.cross_source_agreement?.structural_match ?? false;
    const conflicts = entity.confidence?.cross_source_agreement?.conflicts ?? [];

    const structural = scoreDataPoint(sources, { structuralMatch, conflicts });
    const bioactivity = entity.bioactivity_count > 0 ? scoreDataPoint(sources.filter(s => s === 'chembl').length > 0 ? sources : []) : 0;
    const clinical = entity.trial_count > 0 ? scoreDataPoint(sources.filter(s => s === 'clinicaltrials').length > 0 ? sources : []) : 0;
    const provenanceCompleteness = sources.length > 0 ? 100 : 0;

    const overall = Math.round(
        0.4 * structural + 0.3 * bioactivity + 0.2 * clinical + 0.1 * provenanceCompleteness
    );

    return {
        overall,
        structural,
        bioactivity,
        clinical,
        method: 'cross_source_consensus_v1',
        cross_source_agreement: { structural_match: structuralMatch, conflicts },
    };
}
