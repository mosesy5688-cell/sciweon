/**
 * NegEvidence Builder V0.4.2 — synthesize all negative signals into entity.
 *
 * Unified Negative Evidence synthesis. Single entity type unifies 6+ kinds
 * of negative signals; Agent issues one query to get the full negative
 * profile of any compound/paper/trial.
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
import { NEG_EVIDENCE_TYPES } from '../../src/lib/schemas/neg-evidence-types.js';
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
    // Derive stats dict from the SSoT taxonomy — any new type added there
    // is counted automatically. Prevents the prior failure mode where adding
    // a builder type without updating this dict silently produced `NaN++`.
    const stats = Object.fromEntries(NEG_EVIDENCE_TYPES.map(t => [t, 0]));

    const trackOrThrow = (r) => {
        if (!(r.evidence_type in stats)) {
            throw new Error(
                `[NEG-BUILDER] Unknown evidence_type emitted by builder: ${JSON.stringify(r.evidence_type)} ` +
                `(record id=${r.id}). Add it to src/lib/schemas/neg-evidence-types.js or fix the builder.`,
            );
        }
        records.push(r);
        stats[r.evidence_type]++;
    };

    for (const r of buildTrialNegEvidence(trials, negRaw)) trackOrThrow(r);
    for (const r of buildPaperRetraction(papers)) trackOrThrow(r);
    for (const r of buildBioassayInactive(bioactivities)) trackOrThrow(r);
    for (const r of buildFdaSignals(compounds)) trackOrThrow(r);

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
