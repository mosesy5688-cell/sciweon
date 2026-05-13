/**
 * Agent Simulator V0.1 — bottom-line validator
 *
 * Simulates an AI Agent calling Sciweon data to make virtual-lab decisions.
 * Deterministic (no live LLM calls) — rules + lookups verify Agent expectations.
 *
 * Acceptance criterion (V8 bottom line):
 *   "Any Agent receiving Sciweon data should be immediately able to execute
 *    virtual-lab work."
 *
 * Each test case simulates one Agent decision scenario and checks whether our
 * data exposes the context the Agent needs.
 *
 * Output: data-quality-audit.json (full report of every gap surfaced).
 */

import fs from 'fs/promises';
import path from 'path';
import { TEST_SCENARIOS } from './simulator-scenarios.js';
import { CHECKS } from './simulator-checks.js';

const DATA_DIR = './output/linked';
const OUTPUT_FILE = './output/data-quality-audit.json';

async function loadData() {
    const loadJsonl = async (p) => {
        try {
            const content = await fs.readFile(p, 'utf-8');
            return content.split('\n').filter(Boolean).map(l => JSON.parse(l));
        } catch { return []; }
    };
    // Canonical Retraction Watch presence signals that retraction was checked
    // even when this compound has no retracted papers.
    let retractionIndexAvailable = false;
    let retractionIndexMeta = null;
    try {
        const idxRaw = await fs.readFile('./data/retraction_watch_index.json', 'utf-8');
        const idx = JSON.parse(idxRaw);
        retractionIndexAvailable = idx.record_count > 1000;
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

function buildIndices(data) {
    const compoundByCid = new Map();
    const compoundByInchiKey = new Map();
    const compoundBySynonym = new Map();
    for (const c of data.compounds) {
        compoundByCid.set(c.pubchem_cid, c);
        compoundByInchiKey.set(c.inchi_key, c);
        for (const syn of (c.synonyms || []).slice(0, 10)) compoundBySynonym.set(syn.toLowerCase(), c);
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

function runScenario(scenario, indices, data) {
    const findings = {
        scenario_id: scenario.id,
        question: scenario.question,
        target: scenario.compoundName,
        status: 'unknown',
        evidence: {},
        gaps: [],
        severity: 'info',
    };
    const compound = indices.compoundBySynonym.get(scenario.compoundName.toLowerCase());
    if (!compound) {
        findings.status = 'fail';
        findings.severity = 'critical';
        findings.gaps.push(`Cannot find compound by name "${scenario.compoundName}" — synonym index miss`);
        return findings;
    }
    findings.evidence.compound_id = compound.id;

    for (const expect of scenario.expects) {
        const check = CHECKS[expect];
        if (check) check(compound, { indices, data, findings, expect });
    }

    findings.status = findings.gaps.length === 0 ? 'pass' : 'partial';
    findings.severity = findings.gaps.length > 5
        ? 'critical'
        : findings.gaps.length > 2 ? 'major'
            : findings.gaps.length > 0 ? 'minor' : 'info';
    return findings;
}

function pickBestCompound(data, indices) {
    let best = null, bestScore = -1;
    for (const c of data.compounds) {
        if (!c.chembl_id) continue;
        const bioact = (indices.bioactByCompound.get(c.id) || []).length;
        const trials = (indices.trialsByCompound.get(c.id) || []).length;
        const papers = (indices.papersByCompound.get(c.id) || []).length;
        const score = bioact + trials + papers + (c.drug_status?.max_phase >= 1 ? 100 : 0);
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
}

async function main() {
    console.log('[SIMULATOR] V0.1 Agent bottom-line acceptance test');
    console.log('[SIMULATOR] Acceptance criterion: Agent receiving the data can immediately run virtual-lab work.\n');
    const data = await loadData();
    console.log(`[SIMULATOR] Loaded: ${data.compounds.length} compounds, ${data.bioactivities.length} bioactivities, ${data.trials.length} trials, ${data.papers.length} papers\n`);
    const indices = buildIndices(data);
    const bestCompound = pickBestCompound(data, indices);
    if (!bestCompound) { console.log('[SIMULATOR] FAIL: no cross-source-linked compound found.'); return; }

    const searchName = bestCompound.synonyms?.[0] || bestCompound.iupac_name?.split(' ')[0] || 'unknown';
    console.log(`[SIMULATOR] Test target: ${searchName} (${bestCompound.id})`);
    console.log(`[SIMULATOR]   ChEMBL: ${bestCompound.chembl_id} | max_phase: ${bestCompound.drug_status?.max_phase ?? 'N/A'}`);
    console.log(`[SIMULATOR]   Bioactivities: ${(indices.bioactByCompound.get(bestCompound.id) || []).length}`);
    console.log(`[SIMULATOR]   Trials: ${(indices.trialsByCompound.get(bestCompound.id) || []).length}`);
    console.log(`[SIMULATOR]   Papers: ${(indices.papersByCompound.get(bestCompound.id) || []).length}\n`);
    for (const s of TEST_SCENARIOS) s.compoundName = searchName;

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
        const icon = r.status === 'pass' ? 'OK' : r.status === 'fail' ? 'FAIL' : 'PART';
        console.log(`[${icon}] ${r.scenario_id}: ${r.question} [${r.severity}]`);
        if (r.gaps.length > 0) {
            for (const g of r.gaps.slice(0, 3)) console.log(`     - ${g}`);
            if (r.gaps.length > 3) console.log(`     ... and ${r.gaps.length - 3} more gaps`);
        }
    }
    console.log(`\n=== Summary ===`);
    console.log(`Total: ${summary.total} | Pass: ${summary.pass} | Partial: ${summary.partial} | Fail: ${summary.fail}`);
    console.log(`Severity: ${summary.critical} critical | ${summary.major} major | ${summary.minor} minor`);
    await fs.writeFile(OUTPUT_FILE, JSON.stringify({ summary, results }, null, 2));
    console.log(`\nFull audit: ${OUTPUT_FILE}`);
    const verdict = summary.fail === 0 && summary.critical === 0;
    console.log(`\nBottom-line acceptance: ${verdict ? 'PASS — Agent ready' : 'FAIL — Data gaps must be fixed before V0.4'}`);
}

main().catch(err => { console.error('[SIMULATOR] Fatal:', err); process.exit(1); });
