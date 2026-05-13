/**
 * Simulator checks — compound / bioactivity / trial / failure-evidence domain.
 * Each function takes (compound, ctx) where ctx = { indices, data, findings, expect }
 * and mutates ctx.findings.
 */

// ─── Compound checks ───
export const compoundChecks = {
    structural_data(c, { findings }) {
        if (!c.smiles_canonical || !c.inchi || !c.molecular_formula)
            findings.gaps.push('Missing structural data (smiles/inchi/formula)');
    },
    lipinski_violations(c, { findings }) {
        if (c.properties?.lipinski_violations == null)
            findings.gaps.push('Missing Lipinski violations count');
    },
    synonyms(c, { findings }) {
        if (!c.synonyms || c.synonyms.length === 0)
            findings.gaps.push('No synonyms — Agent cannot match common names');
        else findings.evidence.synonyms_count = c.synonyms.length;
    },
    molecular_weight(c, { findings }) {
        if (!c.molecular_weight?.value || !c.molecular_weight?.unit)
            findings.gaps.push('Missing molecular_weight value or unit');
    },
    confidence_score(c, { findings }) {
        if (c.confidence?.overall == null) findings.gaps.push('Missing overall confidence');
        else if (c.confidence.overall < 50)
            findings.gaps.push(`Confidence too low (${c.confidence.overall}) for Agent decisions`);
        else findings.evidence.confidence = c.confidence.overall;
    },
    max_phase(c, { findings }) {
        if (c.drug_status?.max_phase == null)
            findings.gaps.push('No max_phase — Agent cannot know if compound is approved');
        else findings.evidence.max_phase = c.drug_status.max_phase;
    },
    first_approval_year(c, { findings }) {
        // Primary fact only for APPROVED drugs (max_phase = 4). Phase 1-3 drugs
        // are still in trials and legitimately have no approval year.
        if (c.drug_status?.first_approval_year == null && c.drug_status?.max_phase === 4)
            findings.gaps.push('Approved drug (max_phase=4) but missing first_approval_year');
    },
    withdrawn_status(c, { findings }) {
        if (c.drug_status?.withdrawn == null)
            findings.gaps.push('Missing withdrawn flag — Agent cannot assess safety risk');
    },
    atc_codes() { /* ATC codes optional in ChEMBL, not a gap */ },
};

// ─── Bioactivity checks ───
function bioactivityCount(c, { indices, findings }) {
    const acts = indices.bioactByCompound.get(c.id) || [];
    if (acts.length === 0) {
        findings.gaps.push('No bioactivity data linked to compound');
        return;
    }
    findings.evidence.bioactivity = {
        total: acts.length,
        active: acts.filter(a => a.is_active === true).length,
        inactive: acts.filter(a => a.is_active === false).length,
    };
}

export const bioactivityChecks = {
    active_count: bioactivityCount,
    inactive_count: bioactivityCount,
    target_diversity(c, { indices, findings }) {
        const acts = indices.bioactByCompound.get(c.id) || [];
        const targets = new Set(acts.map(a => a.target_id).filter(Boolean));
        if (targets.size === 0 && acts.length > 0)
            findings.gaps.push('Bioactivities have no target diversity (all unknown targets)');
    },
    ic50_values(c, { indices, findings }) {
        const acts = indices.bioactByCompound.get(c.id) || [];
        const ic50s = acts.filter(a => a.activity_type === 'IC50' && a.value > 0);
        if (acts.length > 0 && ic50s.length === 0)
            findings.gaps.push('No IC50 values among bioactivities — limits screening usefulness');
    },
    units_standardized(c, { indices, findings }) {
        const acts = indices.bioactByCompound.get(c.id) || [];
        const unknownUnits = acts.filter(a => a.unit === 'unitless').length;
        if (acts.length > 0 && unknownUnits / acts.length > 0.3)
            findings.gaps.push(`${unknownUnits}/${acts.length} bioactivities have unitless values — unsafe for cross-study comparison`);
    },
};

// ─── Trial checks ───
const DRUG_INTERVENTION_TYPES = new Set(['DRUG', 'BIOLOGICAL', 'COMBINATION_PRODUCT']);

export const trialChecks = {
    trial_count(c, { indices, findings }) {
        const ts = indices.trialsByCompound.get(c.id) || [];
        if (ts.length === 0) findings.gaps.push('No clinical trials linked to compound');
        else findings.evidence.trial_count = ts.length;
    },
    phase_distribution(c, { indices, findings }) {
        // Phase only applies to drug-type trials (CT.gov data model).
        // PROCEDURE / DEVICE / DIAGNOSTIC types legitimately have no phase.
        const ts = (indices.trialsByCompound.get(c.id) || [])
            .map(id => indices.trialById.get(id)).filter(Boolean);
        const drugTrials = ts.filter(t =>
            (t.interventions || []).some(i => DRUG_INTERVENTION_TYPES.has(i.type)));
        if (drugTrials.length === 0) return;
        const phases = drugTrials.filter(t => t.phase != null).length;
        findings.evidence.phase_distribution = { drug_trials: drugTrials.length, with_phase: phases };
        if (phases / drugTrials.length < 0.5)
            findings.gaps.push(`Only ${phases}/${drugTrials.length} drug trials have phase info`);
    },
    completed_vs_terminated(c, { indices, findings }) {
        const ts = (indices.trialsByCompound.get(c.id) || [])
            .map(id => indices.trialById.get(id)).filter(Boolean);
        findings.evidence.terminated_trials = ts.filter(t => t.is_negative_outcome).length;
    },
    conditions_covered(c, { indices, findings }) {
        const ts = (indices.trialsByCompound.get(c.id) || [])
            .map(id => indices.trialById.get(id)).filter(Boolean);
        if (ts.length === 0) return;
        const conditions = new Set(ts.flatMap(t => t.conditions || []));
        if (conditions.size === 0) findings.gaps.push('No conditions extracted from trials');
    },
};

// ─── Failure / Negative Evidence checks ───
export const failureChecks = {
    negative_outcomes(c, { data, findings }) {
        const negs = data.negEvidence.filter(n => n.compound_id === c.id);
        if (negs.length === 0)
            findings.gaps.push('No negative evidence for this compound (could be true OR data gap)');
        else findings.evidence.negative_evidence_count = negs.length;
    },
    whyStopped_text(c, { data, findings }) {
        const negs = data.negEvidence.filter(n => n.compound_id === c.id);
        const withReason = negs.filter(n => n.status_reason && n.status_reason.length > 0);
        if (negs.length > 0 && withReason.length === 0)
            findings.gaps.push('All negative outcomes lack whyStopped text — Agent cannot reason about failure cause');
    },
    failure_classification(c, { data, findings }) {
        const negs = data.negEvidence.filter(n => n.compound_id === c.id);
        if (negs.length === 0) return;
        const classified = negs.filter(n => n.failure_classification?.category);
        if (classified.length === 0) {
            findings.gaps.push('Failure reasons are raw text only — no SAFETY/EFFICACY/ENROLLMENT classification');
            return;
        }
        const known = classified.filter(n =>
            n.failure_classification.category !== 'OTHER' && n.failure_classification.confidence >= 50);
        const knownPct = (100 * known.length / negs.length).toFixed(1);
        findings.evidence.failure_classification = {
            total: negs.length,
            classified: classified.length,
            known_category_pct: knownPct,
            avg_confidence: Math.round(
                classified.reduce((s, n) => s + (n.failure_classification.confidence || 0), 0) / classified.length),
        };
        if (known.length / negs.length < 0.3)
            findings.gaps.push(`Only ${knownPct}% of failures have a known category (V0.4 NLP can improve)`);
    },
};
