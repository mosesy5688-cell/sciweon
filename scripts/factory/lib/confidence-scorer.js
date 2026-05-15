/**
 * Confidence Scorer V2 — Sciweon Principle 5 quantification.
 *
 * Per Sciweon 6 first principles #5:
 *   - Single source: confidence ceiling = 60 (hard cap)
 *   - Multi-source consensus: confidence floor = 80
 *   - Conflicts reduce further
 *
 * V1 lesson (cycle 1 audit): the previous formula `60 + (n-1)*10 + source_weight`
 * gave single-source records >60 because source weight was always added on top
 * of base 60. R2 cycle 1 had 0/39 single-source papers below 60 (rule broken).
 * V2 separates single-source and multi-source paths so the cap is structural,
 * not post-hoc.
 */

const SOURCE_WEIGHTS = {
    pubchem: 10,
    chembl: 10,
    clinicaltrials: 5,
    openalex: 5,
    s2: 5,
    semantic_scholar: 5, // alias for s2 — both names accepted in provenance.sources
    pubmed: 7,           // NIH NCBI authoritative biomedical index
};

const SINGLE_SOURCE_CEILING = 60;
const MULTI_SOURCE_FLOOR = 80;

export function scoreDataPoint(sources, options = {}) {
    const { structuralMatch = false, conflicts = [] } = options;
    if (!Array.isArray(sources) || sources.length === 0) return 0;

    const sourceQualityBonus = sources.reduce((sum, s) => sum + (SOURCE_WEIGHTS[s] || 0), 0);

    if (sources.length === 1) {
        // Principle 5: single-source ceiling enforced structurally
        let score = 40 + Math.min(20, sourceQualityBonus);
        if (conflicts.length > 0) score -= 15;
        return Math.max(0, Math.min(SINGLE_SOURCE_CEILING, Math.round(score)));
    }

    // Multi-source consensus: floor 80, climbs with sources + structural match
    let score = MULTI_SOURCE_FLOOR;
    score += (sources.length - 2) * 3; // each additional source after the 2nd +3
    if (structuralMatch) score += 5;
    score += Math.min(15, Math.round(sourceQualityBonus / 2)); // half the per-source weight in multi-source mode
    if (conflicts.length > 0) score -= 30; // conflicts can drop multi below 80, reflecting disagreement
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
    let overall = Math.round(
        activeDims.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight
    );

    // Re-apply principle 5 cap at the entity level: provenance_completeness=100
    // would otherwise pull single-source entities above 60 via the weighted avg.
    if (sources.length === 1) overall = Math.min(SINGLE_SOURCE_CEILING, overall);

    return {
        overall,
        structural,
        bioactivity,
        clinical,
        method: 'cross_source_consensus_v2',
        cross_source_agreement: { structural_match: structuralMatch, conflicts },
    };
}
