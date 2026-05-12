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

    // Bioactivity confidence: score if entity has chembl source AND any bioactivity data exists
    const hasChembl = sources.includes('chembl');
    const bioactivityCount = (entity.stats?.bioactivity_count_active ?? 0) + (entity.stats?.bioactivity_count_inactive ?? 0);
    const hasBioactivity = hasChembl && bioactivityCount > 0;

    // Clinical confidence: score if entity has trial source
    const hasTrial = sources.includes('clinicaltrials');
    const trialCount = (entity.stats?.trial_count_active ?? 0) + (entity.stats?.trial_count_terminated ?? 0);
    const hasClinical = hasTrial && trialCount > 0;

    const structural = scoreDataPoint(sources, { structuralMatch, conflicts });
    const bioactivity = hasBioactivity ? scoreDataPoint(sources, { structuralMatch }) : 0;
    const clinical = hasClinical ? scoreDataPoint(sources, { structuralMatch }) : 0;
    const provenanceCompleteness = sources.length > 0 ? 100 : 0;

    // Weighted overall (only count dimensions that have data)
    // This prevents penalizing single-vertical entities (e.g., a pure structural compound)
    const dimensions = [
        { score: structural, weight: 0.4, present: true },
        { score: bioactivity, weight: 0.3, present: hasBioactivity },
        { score: clinical, weight: 0.2, present: hasClinical },
        { score: provenanceCompleteness, weight: 0.1, present: true },
    ];
    const activeDims = dimensions.filter(d => d.present);
    const totalWeight = activeDims.reduce((s, d) => s + d.weight, 0);
    const overall = Math.round(
        activeDims.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight
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
