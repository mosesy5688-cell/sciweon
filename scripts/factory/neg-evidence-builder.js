/**
 * NegEvidence Builder V0.4.2 — synthesize all negative signals into entity.
 *
 * Sciweon's primary differentiation pillar (per SCIWEON_NEGATIVE_EVIDENCE_DB.md
 * + 2026-05-13 strategic reframe Layer 3). Single entity type unifies
 * 6+ kinds of negative signals; Agent issues one query to get the full
 * negative profile of any compound/paper/trial.
 *
 * Input data sources (all already in output/linked/):
 *   - negative-evidence-raw.jsonl  (V0.1 keyword classifier output)
 *   - trials.jsonl                 (V0.3.5 ResultsSection serious_events_count)
 *   - papers.jsonl                 (V0.2.3 retraction PRIMARY facts)
 *   - bioactivities.jsonl          (V0.2.2 is_active=false from Sciweon scorer)
 *   - compounds-enriched.jsonl     (V0.3.4 openFDA boxed_warning, V0.4.1 FAERS)
 *
 * Output: output/linked/neg-evidence.jsonl
 */

import fs from 'fs/promises';
import path from 'path';
import { NEG_EVIDENCE_SCHEMA } from '../../src/lib/schemas/neg-evidence.js';
import { gate } from './lib/validation-gate.js';
import { buildTrialNegEvidence } from './lib/neg-builders-trial.js';
import { buildBioassayInactive, buildPaperRetraction } from './lib/neg-builders-paper-bio.js';
import { buildFdaSignals } from './lib/neg-builders-fda.js';

const DATA_DIR = './output/linked';

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

async function main() {
    console.log('[NEG-BUILDER] V0.4.2 — synthesize NegEvidence entity');

    const [trials, papers, bioactivities, compounds, negRaw] = await Promise.all([
        loadJsonl(path.join(DATA_DIR, 'trials.jsonl')),
        loadJsonl(path.join(DATA_DIR, 'papers.jsonl')),
        loadJsonl(path.join(DATA_DIR, 'bioactivities.jsonl')),
        loadJsonl(path.join(DATA_DIR, 'compounds-enriched.jsonl')),
        loadJsonl(path.join(DATA_DIR, 'negative-evidence-raw.jsonl')),
    ]);
    console.log(`[NEG-BUILDER] Inputs loaded: ${trials.length} trials, ${papers.length} papers, ${bioactivities.length} bioactivities, ${compounds.length} compounds, ${negRaw.length} raw neg evidence`);

    const records = [];
    const stats = {
        trial_failure: 0,
        serious_adverse_event_per_trial: 0,
        paper_retraction: 0,
        inactive_bioassay: 0,
        black_box_warning: 0,
        drug_withdrawal: 0,
        faers_adr_signal: 0,
    };

    for (const r of buildTrialNegEvidence(trials, negRaw)) {
        records.push(r);
        stats[r.evidence_type]++;
    }
    for (const r of buildPaperRetraction(papers)) {
        records.push(r);
        stats[r.evidence_type]++;
    }
    for (const r of buildBioassayInactive(bioactivities)) {
        records.push(r);
        stats[r.evidence_type]++;
    }
    for (const r of buildFdaSignals(compounds)) {
        records.push(r);
        stats[r.evidence_type]++;
    }

    let validCount = 0;
    let invalidCount = 0;
    const validated = [];
    for (const r of records) {
        const result = gate(r, NEG_EVIDENCE_SCHEMA, r.id);
        if (result.passed) { validated.push(r); validCount++; }
        else invalidCount++;
    }

    await writeJsonl(path.join(DATA_DIR, 'neg-evidence.jsonl'), validated);

    console.log(`\n[NEG-BUILDER] Complete`);
    console.log(`  Total records:           ${records.length}`);
    console.log(`  Schema-valid:            ${validCount}`);
    console.log(`  Validation failures:     ${invalidCount}`);
    console.log(`  By evidence_type:`);
    for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${k.padEnd(35)} ${v}`);
    }
    const bySeverity = { critical: 0, major: 0, minor: 0, unknown: 0 };
    for (const r of validated) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    console.log(`  By severity:             critical=${bySeverity.critical} | major=${bySeverity.major} | minor=${bySeverity.minor} | unknown=${bySeverity.unknown}`);
}

main().catch(err => { console.error('[NEG-BUILDER] Fatal:', err); process.exit(1); });
