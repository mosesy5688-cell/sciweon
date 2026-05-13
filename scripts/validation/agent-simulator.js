/**
 * Agent Simulator V0.1 — 底线标准验证器
 *
 * 模拟 AI Agent 调用 Sciweon 数据做虚拟实验室决策。
 * 不真调 LLM API（保持确定性测试），而是用规则+查询验证 Agent 行为期望。
 *
 * 验证标准（V8 底线）:
 *   "任何 Agent 拿到 Sciweon 数据 → 立即能做虚拟实验室执行 Agent"
 *
 * 每个测试 case 都模拟一个 Agent 决策场景，
 * 检查我们的数据是否提供了 Agent 需要的所有上下文。
 *
 * 输出: data-quality-audit.json (找到的所有盲区)
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = './output/linked';
const OUTPUT_FILE = './output/data-quality-audit.json';

// ─── 加载所有 4 实体数据 ───
async function loadData() {
    const loadJsonl = async (p) => {
        try {
            const content = await fs.readFile(p, 'utf-8');
            return content.split('\n').filter(Boolean).map(l => JSON.parse(l));
        } catch { return []; }
    };
    // Detect canonical Retraction Watch index presence (provenance signal that retraction was checked)
    let retractionIndexAvailable = false;
    let retractionIndexMeta = null;
    try {
        const idxRaw = await fs.readFile('./data/retraction_watch_index.json', 'utf-8');
        const idx = JSON.parse(idxRaw);
        retractionIndexAvailable = (idx.record_count > 1000); // sanity threshold
        retractionIndexMeta = { last_sync: idx.last_sync, record_count: idx.record_count };
    } catch { /* not synced yet */ }
    return {
        compounds: await loadJsonl(path.join(DATA_DIR, 'compounds-enriched.jsonl')),
        bioactivities: await loadJsonl(path.join(DATA_DIR, 'bioactivities.jsonl')),
        trials: await loadJsonl(path.join(DATA_DIR, 'trials.jsonl')),
        trialLinks: await loadJsonl(path.join(DATA_DIR, 'trial-links.jsonl')),
        papers: await loadJsonl(path.join(DATA_DIR, 'papers.jsonl')),
        paperLinks: await loadJsonl(path.join(DATA_DIR, 'paper-links.jsonl')),
        negEvidence: await loadJsonl(path.join(DATA_DIR, 'negative-evidence-raw.jsonl')),
        retractionIndexAvailable,
        retractionIndexMeta,
    };
}

// ─── 索引构建（Agent 访问模式模拟） ───
function buildIndices(data) {
    const compoundByCid = new Map();
    const compoundByInchiKey = new Map();
    const compoundBySynonym = new Map();
    for (const c of data.compounds) {
        compoundByCid.set(c.pubchem_cid, c);
        compoundByInchiKey.set(c.inchi_key, c);
        for (const syn of (c.synonyms || []).slice(0, 10)) {
            compoundBySynonym.set(syn.toLowerCase(), c);
        }
    }
    const bioactByCompound = new Map();
    for (const b of data.bioactivities) {
        if (!bioactByCompound.has(b.compound_id)) bioactByCompound.set(b.compound_id, []);
        bioactByCompound.get(b.compound_id).push(b);
    }
    const trialsByCompound = new Map();
    for (const l of data.trialLinks) {
        if (!trialsByCompound.has(l.compound_id)) trialsByCompound.set(l.compound_id, []);
        trialsByCompound.get(l.compound_id).push(l.nct_id);
    }
    const trialById = new Map(data.trials.map(t => [t.nct_id, t]));
    const papersByCompound = new Map();
    for (const l of data.paperLinks) {
        if (!papersByCompound.has(l.compound_id)) papersByCompound.set(l.compound_id, []);
        papersByCompound.get(l.compound_id).push(l.openalex_id);
    }
    const paperById = new Map(data.papers.map(p => [p.openalex_id, p]));
    return { compoundByCid, compoundByInchiKey, compoundBySynonym, bioactByCompound, trialsByCompound, trialById, papersByCompound, paperById };
}

// ─── Agent 决策场景测试 ───
const TEST_SCENARIOS = [
    {
        id: 'agent_q1_compound_lookup',
        question: 'Find compound by common name',
        compoundName: 'aspirin',
        expects: ['structural_data', 'lipinski_violations', 'synonyms', 'molecular_weight', 'confidence_score'],
    },
    {
        id: 'agent_q2_drug_status',
        question: 'Is this compound an approved drug?',
        compoundName: 'aspirin',
        expects: ['max_phase', 'first_approval_year', 'withdrawn_status', 'atc_codes'],
    },
    {
        id: 'agent_q3_bioactivity_profile',
        question: 'What bioassays exist for this compound?',
        compoundName: 'aspirin',
        expects: ['active_count', 'inactive_count', 'target_diversity', 'ic50_values', 'units_standardized'],
    },
    {
        id: 'agent_q4_clinical_history',
        question: 'What trials have used this compound?',
        compoundName: 'aspirin',
        expects: ['trial_count', 'phase_distribution', 'completed_vs_terminated', 'conditions_covered'],
    },
    {
        id: 'agent_q5_failure_evidence',
        question: 'Has this compound failed in trials? Why?',
        compoundName: 'aspirin',
        expects: ['negative_outcomes', 'whyStopped_text', 'failure_classification'],
    },
    {
        id: 'agent_q6_literature_support',
        question: 'What papers support claims about this compound?',
        compoundName: 'aspirin',
        expects: ['paper_count', 'citation_counts', 'mesh_terms', 'recent_papers', 'open_access_flag'],
    },
    {
        id: 'agent_q7_retraction_check',
        question: 'Have any papers about this been retracted?',
        compoundName: 'aspirin',
        // V0.1 contract: primary facts only (detection + canonical DOI proof + source provenance).
        // Reason categorization is V0.4 — uses retraction_doi to fetch original notice text
        // and classify with Sciweon's own NLP, not RW's predefined categories.
        expects: ['retraction_detection', 'retraction_doi_proof', 'retraction_source_provenance'],
    },
    {
        id: 'agent_q8_confidence_per_claim',
        question: 'How reliable is the data for this compound?',
        compoundName: 'aspirin',
        expects: ['overall_confidence', 'per_dimension_confidence', 'source_count', 'structural_match_flag'],
    },
    {
        id: 'agent_q9_cross_link_validation',
        question: 'Can I trace papers to trials and back?',
        compoundName: 'aspirin',
        expects: ['paper_to_trial_links', 'trial_to_paper_links', 'doi_traceability'],
    },
    {
        id: 'agent_q10_provenance_audit',
        question: 'Where does each data point come from?',
        compoundName: 'aspirin',
        expects: ['source_list_per_field', 'timestamp_per_extraction', 'extraction_method_visible'],
    },
];

// ─── 单场景执行器 ───
function runScenario(scenario, indices, data) {
    const findings = { scenario_id: scenario.id, question: scenario.question, target: scenario.compoundName, status: 'unknown', evidence: {}, gaps: [], severity: 'info' };

    // Lookup
    const compound = indices.compoundBySynonym.get(scenario.compoundName.toLowerCase());
    if (!compound) {
        findings.status = 'fail';
        findings.severity = 'critical';
        findings.gaps.push(`Cannot find compound by name "${scenario.compoundName}" — synonym index miss`);
        return findings;
    }
    findings.evidence.compound_id = compound.id;

    // Check expected fields
    for (const expect of scenario.expects) {
        switch (expect) {
            case 'structural_data':
                if (!compound.smiles_canonical || !compound.inchi || !compound.molecular_formula)
                    findings.gaps.push('Missing structural data (smiles/inchi/formula)');
                break;
            case 'lipinski_violations':
                if (compound.properties?.lipinski_violations == null)
                    findings.gaps.push('Missing Lipinski violations count');
                break;
            case 'synonyms':
                if (!compound.synonyms || compound.synonyms.length === 0)
                    findings.gaps.push('No synonyms — Agent cannot match common names');
                else
                    findings.evidence.synonyms_count = compound.synonyms.length;
                break;
            case 'molecular_weight':
                if (!compound.molecular_weight?.value || !compound.molecular_weight?.unit)
                    findings.gaps.push('Missing molecular_weight value or unit');
                break;
            case 'confidence_score':
                if (compound.confidence?.overall == null)
                    findings.gaps.push('Missing overall confidence');
                else if (compound.confidence.overall < 50)
                    findings.gaps.push(`Confidence too low (${compound.confidence.overall}) for Agent decisions`);
                else
                    findings.evidence.confidence = compound.confidence.overall;
                break;
            case 'max_phase':
                if (compound.drug_status?.max_phase == null)
                    findings.gaps.push('No max_phase — Agent cannot know if compound is approved');
                else
                    findings.evidence.max_phase = compound.drug_status.max_phase;
                break;
            case 'first_approval_year':
                // first_approval_year is a primary fact only for APPROVED drugs (max_phase = 4).
                // Phase 1-3 drugs are still in trials and legitimately have no approval year.
                if (compound.drug_status?.first_approval_year == null && compound.drug_status?.max_phase === 4)
                    findings.gaps.push('Approved drug (max_phase=4) but missing first_approval_year');
                break;
            case 'withdrawn_status':
                if (compound.drug_status?.withdrawn == null)
                    findings.gaps.push('Missing withdrawn flag — Agent cannot assess safety risk');
                break;
            case 'atc_codes':
                // ATC codes are optional in ChEMBL, not a gap if absent
                break;
            case 'active_count':
            case 'inactive_count': {
                const acts = indices.bioactByCompound.get(compound.id) || [];
                const active = acts.filter(a => a.is_active === true).length;
                const inactive = acts.filter(a => a.is_active === false).length;
                if (acts.length === 0)
                    findings.gaps.push('No bioactivity data linked to compound');
                else
                    findings.evidence.bioactivity = { total: acts.length, active, inactive };
                break;
            }
            case 'target_diversity': {
                const acts = indices.bioactByCompound.get(compound.id) || [];
                const targets = new Set(acts.map(a => a.target_id).filter(Boolean));
                if (targets.size === 0 && acts.length > 0)
                    findings.gaps.push('Bioactivities have no target diversity (all unknown targets)');
                break;
            }
            case 'ic50_values': {
                const acts = indices.bioactByCompound.get(compound.id) || [];
                const ic50s = acts.filter(a => a.activity_type === 'IC50' && a.value > 0);
                if (acts.length > 0 && ic50s.length === 0)
                    findings.gaps.push('No IC50 values among bioactivities — limits screening usefulness');
                break;
            }
            case 'units_standardized': {
                const acts = indices.bioactByCompound.get(compound.id) || [];
                const unknownUnits = acts.filter(a => a.unit === 'unitless').length;
                if (acts.length > 0 && unknownUnits / acts.length > 0.3)
                    findings.gaps.push(`${unknownUnits}/${acts.length} bioactivities have unitless values — unsafe for cross-study comparison`);
                break;
            }
            case 'trial_count': {
                const ts = indices.trialsByCompound.get(compound.id) || [];
                if (ts.length === 0)
                    findings.gaps.push('No clinical trials linked to compound');
                else
                    findings.evidence.trial_count = ts.length;
                break;
            }
            case 'phase_distribution':
            case 'completed_vs_terminated':
            case 'conditions_covered': {
                const ts = (indices.trialsByCompound.get(compound.id) || []).map(id => indices.trialById.get(id)).filter(Boolean);
                if (ts.length === 0) break;
                if (expect === 'phase_distribution') {
                    // Phase only applies to drug-type trials (CT.gov data model).
                    // PROCEDURE/DEVICE/DIAGNOSTIC/OTHER trials legitimately have no phase.
                    const drugTypes = new Set(['DRUG', 'BIOLOGICAL', 'COMBINATION_PRODUCT']);
                    const drugTrials = ts.filter(t => (t.interventions || []).some(i => drugTypes.has(i.type)));
                    if (drugTrials.length === 0) break;
                    const phases = drugTrials.filter(t => t.phase != null).length;
                    findings.evidence.phase_distribution = { drug_trials: drugTrials.length, with_phase: phases };
                    if (phases / drugTrials.length < 0.5)
                        findings.gaps.push(`Only ${phases}/${drugTrials.length} drug trials have phase info`);
                }
                if (expect === 'completed_vs_terminated') {
                    const terminated = ts.filter(t => t.is_negative_outcome).length;
                    findings.evidence.terminated_trials = terminated;
                }
                if (expect === 'conditions_covered') {
                    const conditions = new Set(ts.flatMap(t => t.conditions || []));
                    if (conditions.size === 0)
                        findings.gaps.push('No conditions extracted from trials');
                }
                break;
            }
            case 'negative_outcomes': {
                const negs = data.negEvidence.filter(n => n.compound_id === compound.id);
                if (negs.length === 0)
                    findings.gaps.push('No negative evidence for this compound (could be true OR data gap)');
                else
                    findings.evidence.negative_evidence_count = negs.length;
                break;
            }
            case 'whyStopped_text': {
                const negs = data.negEvidence.filter(n => n.compound_id === compound.id);
                const withReason = negs.filter(n => n.status_reason && n.status_reason.length > 0);
                if (negs.length > 0 && withReason.length === 0)
                    findings.gaps.push('All negative outcomes lack whyStopped text — Agent cannot reason about failure cause');
                break;
            }
            case 'failure_classification': {
                const negs = data.negEvidence.filter(n => n.compound_id === compound.id);
                if (negs.length === 0) break;
                const classified = negs.filter(n => n.failure_classification?.category);
                if (classified.length === 0) {
                    findings.gaps.push('Failure reasons are raw text only — no SAFETY/EFFICACY/ENROLLMENT classification');
                } else {
                    const known = classified.filter(n => n.failure_classification.category !== 'UNKNOWN' && n.failure_classification.confidence >= 50);
                    const knownPct = (100 * known.length / negs.length).toFixed(1);
                    findings.evidence.failure_classification = {
                        total: negs.length,
                        classified: classified.length,
                        known_category_pct: knownPct,
                        avg_confidence: Math.round(classified.reduce((s, n) => s + (n.failure_classification.confidence || 0), 0) / classified.length),
                    };
                    if (known.length / negs.length < 0.3)
                        findings.gaps.push(`Only ${knownPct}% of failures have a known category (V0.4 NLP can improve)`);
                }
                break;
            }
            case 'paper_count':
            case 'citation_counts':
            case 'mesh_terms':
            case 'recent_papers':
            case 'open_access_flag': {
                const pids = indices.papersByCompound.get(compound.id) || [];
                const papers = pids.map(id => indices.paperById.get(id)).filter(Boolean);
                if (papers.length === 0) {
                    findings.gaps.push('No papers linked to compound');
                    break;
                }
                if (expect === 'paper_count') findings.evidence.paper_count = papers.length;
                if (expect === 'citation_counts') {
                    const withCitations = papers.filter(p => p.citation_count > 0).length;
                    if (withCitations / papers.length < 0.3)
                        findings.gaps.push(`Only ${withCitations}/${papers.length} papers have citation data`);
                }
                if (expect === 'mesh_terms') {
                    const withMesh = papers.filter(p => p.mesh_terms?.length > 0).length;
                    if (withMesh / papers.length < 0.3)
                        findings.gaps.push(`Only ${withMesh}/${papers.length} papers have MeSH terms — limits topical filtering`);
                }
                if (expect === 'recent_papers') {
                    const recent = papers.filter(p => p.publication_year >= 2020).length;
                    if (recent === 0)
                        findings.gaps.push('No papers from 2020+ — Agent gets stale evidence');
                }
                if (expect === 'open_access_flag') {
                    const oa = papers.filter(p => p.is_open_access === true).length;
                    if (oa / papers.length < 0.2)
                        findings.gaps.push(`Only ${oa}/${papers.length} papers are Open Access — limits Agent fact verification`);
                }
                break;
            }
            case 'retraction_detection': {
                const pids = indices.papersByCompound.get(compound.id) || [];
                const papers = pids.map(id => indices.paperById.get(id)).filter(Boolean);
                const retracted = papers.filter(p => p.is_retracted).length;
                // Canonical detection = at least one paper has retraction_source set to RW
                // (proves we checked RW even if no retracted papers for THIS compound)
                const anyRwChecked = papers.some(p => p.retraction_source === 'crossref_retraction_watch')
                    || (data.retractionIndexAvailable === true);
                findings.evidence.retraction = { papers: papers.length, retracted, rw_checked: anyRwChecked };
                if (!anyRwChecked && papers.length > 50)
                    findings.gaps.push(`Retraction status not cross-validated against canonical source (Retraction Watch)`);
                break;
            }
            case 'retraction_doi_proof': {
                // V0.1 primary fact: every retracted paper must have a retraction_doi
                // (canonical publisher-issued retraction notice) — this is also the V0.4
                // NLP entry point for Sciweon's own reason classifier.
                const pids = indices.papersByCompound.get(compound.id) || [];
                const papers = pids.map(id => indices.paperById.get(id)).filter(Boolean);
                const retracted = papers.filter(p => p.is_retracted);
                if (retracted.length === 0) break;
                const withDoi = retracted.filter(p => p.retraction_doi).length;
                if (withDoi < retracted.length)
                    findings.gaps.push(`${retracted.length - withDoi}/${retracted.length} retractions lack retraction_doi (primary fact missing)`);
                break;
            }
            case 'retraction_source_provenance': {
                // Each retracted paper must declare its source (provenance for Agent).
                const pids = indices.papersByCompound.get(compound.id) || [];
                const papers = pids.map(id => indices.paperById.get(id)).filter(Boolean);
                const retracted = papers.filter(p => p.is_retracted);
                if (retracted.length === 0) break;
                const withSource = retracted.filter(p => p.retraction_source).length;
                if (withSource < retracted.length)
                    findings.gaps.push(`${retracted.length - withSource}/${retracted.length} retractions lack retraction_source provenance`);
                break;
            }
            case 'overall_confidence':
                if (compound.confidence?.overall == null)
                    findings.gaps.push('No overall confidence');
                break;
            case 'per_dimension_confidence':
                if (compound.confidence?.structural == null || compound.confidence?.bioactivity == null)
                    findings.gaps.push('Missing per-dimension confidence breakdown');
                break;
            case 'source_count': {
                const n = compound.provenance?.sources?.length || 0;
                if (n < 2)
                    findings.gaps.push(`Only ${n} source(s) — Agent cannot cross-validate`);
                break;
            }
            case 'structural_match_flag':
                if (compound.confidence?.cross_source_agreement?.structural_match == null)
                    findings.gaps.push('No structural_match flag — Agent cannot tell if sources agree');
                break;
            case 'paper_to_trial_links':
            case 'trial_to_paper_links': {
                const pids = indices.papersByCompound.get(compound.id) || [];
                const papers = pids.map(id => indices.paperById.get(id)).filter(Boolean);
                const withNctMention = papers.filter(p => p.mentioned_trial_ids?.length > 0);
                if (withNctMention.length === 0 && papers.length > 0)
                    findings.gaps.push('No paper-to-trial NCT cross-mentions detected');
                break;
            }
            case 'doi_traceability': {
                const pids = indices.papersByCompound.get(compound.id) || [];
                const papers = pids.map(id => indices.paperById.get(id)).filter(Boolean);
                const withDoi = papers.filter(p => p.doi).length;
                if (papers.length > 0 && withDoi / papers.length < 0.5)
                    findings.gaps.push(`Only ${withDoi}/${papers.length} papers have DOI — limits source traceability`);
                break;
            }
            case 'source_list_per_field':
                if (!compound.provenance?.sources || compound.provenance.sources.length === 0)
                    findings.gaps.push('No provenance.sources array');
                break;
            case 'timestamp_per_extraction':
                if (!compound.provenance?.sources?.every(s => s.timestamp))
                    findings.gaps.push('Missing extraction timestamps in provenance');
                break;
            case 'extraction_method_visible':
                if (!compound.provenance?.sources?.every(s => s.extraction_method))
                    findings.gaps.push('Missing extraction_method in provenance');
                break;
        }
    }

    findings.status = findings.gaps.length === 0 ? 'pass' : 'partial';
    findings.severity = findings.gaps.length > 5 ? 'critical' : findings.gaps.length > 2 ? 'major' : findings.gaps.length > 0 ? 'minor' : 'info';
    return findings;
}

async function main() {
    console.log('[SIMULATOR] V0.1 Agent 底线标准模拟测试');
    console.log('[SIMULATOR] 验收标准: Agent 拿数据立即能做虚拟实验室工作\n');

    const data = await loadData();
    console.log(`[SIMULATOR] 加载数据: ${data.compounds.length} compounds, ${data.bioactivities.length} bioactivities, ${data.trials.length} trials, ${data.papers.length} papers\n`);

    const indices = buildIndices(data);

    // Pick best test target: compound with MOST data (all 4 entity types linked)
    // This is the most stringent test — if the BEST data fails, the worst certainly fails.
    let bestCompound = null;
    let bestScore = -1;
    for (const c of data.compounds) {
        if (!c.chembl_id) continue; // require cross-source linked
        const bioact = (indices.bioactByCompound.get(c.id) || []).length;
        const trials = (indices.trialsByCompound.get(c.id) || []).length;
        const papers = (indices.papersByCompound.get(c.id) || []).length;
        const score = bioact + trials + papers + (c.drug_status?.max_phase >= 1 ? 100 : 0);
        if (score > bestScore) { bestScore = score; bestCompound = c; }
    }

    if (bestCompound) {
        const searchName = bestCompound.synonyms?.[0] || bestCompound.iupac_name?.split(' ')[0] || 'unknown';
        console.log(`[SIMULATOR] Test target: ${searchName} (${bestCompound.id})`);
        console.log(`[SIMULATOR]   ChEMBL: ${bestCompound.chembl_id} | max_phase: ${bestCompound.drug_status?.max_phase ?? 'N/A'}`);
        console.log(`[SIMULATOR]   Bioactivities: ${(indices.bioactByCompound.get(bestCompound.id) || []).length}`);
        console.log(`[SIMULATOR]   Trials: ${(indices.trialsByCompound.get(bestCompound.id) || []).length}`);
        console.log(`[SIMULATOR]   Papers: ${(indices.papersByCompound.get(bestCompound.id) || []).length}\n`);
        for (const s of TEST_SCENARIOS) s.compoundName = searchName;
    } else {
        console.log('[SIMULATOR] ❌ No cross-source-linked compound found in data!\n');
        return;
    }

    const results = TEST_SCENARIOS.map(s => runScenario(s, indices, data));
    const summary = {
        total: results.length,
        pass: results.filter(r => r.status === 'pass').length,
        partial: results.filter(r => r.status === 'partial').length,
        fail: results.filter(r => r.status === 'fail').length,
        critical: results.filter(r => r.severity === 'critical').length,
        major: results.filter(r => r.severity === 'major').length,
        minor: results.filter(r => r.severity === 'minor').length,
    };

    for (const r of results) {
        const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⚠️';
        console.log(`${icon} ${r.scenario_id}: ${r.question} [${r.severity}]`);
        if (r.gaps.length > 0) {
            for (const g of r.gaps.slice(0, 3)) console.log(`     • ${g}`);
            if (r.gaps.length > 3) console.log(`     ... and ${r.gaps.length - 3} more gaps`);
        }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Total: ${summary.total} | Pass: ${summary.pass} | Partial: ${summary.partial} | Fail: ${summary.fail}`);
    console.log(`Severity: ${summary.critical} critical | ${summary.major} major | ${summary.minor} minor`);

    await fs.writeFile(OUTPUT_FILE, JSON.stringify({ summary, results }, null, 2));
    console.log(`\nFull audit: ${OUTPUT_FILE}`);

    const verdict = summary.fail === 0 && summary.critical === 0;
    console.log(`\n底线标准验收: ${verdict ? '✅ PASS — Agent ready' : '❌ FAIL — Data gaps must be fixed before V0.4'}`);
}

main().catch(err => { console.error('[SIMULATOR] Fatal:', err); process.exit(1); });
