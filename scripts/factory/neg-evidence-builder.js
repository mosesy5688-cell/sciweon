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
import { NEG_EVIDENCE_TYPES, buildNegAnchorPayload } from '../../src/lib/schemas/neg-evidence-types.js';
import { gate } from './lib/validation-gate.js';
import { buildTrialNegEvidence } from './lib/neg-builders-trial.js';
import { buildBioassayInactive, buildPaperRetraction } from './lib/neg-builders-paper-bio.js';
import { buildFdaSignals, boxedWarningStats, resetBoxedWarningStats } from './lib/neg-builders-fda.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const DATA_DIR = './output/linked';

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

async function main() {
    console.log('[NEG-BUILDER] V0.4.2 — synthesize NegEvidence entity');

    const [trials, papers, bioactivities, compounds, negRaw] = await Promise.all([
        loadJsonlStrict(path.join(DATA_DIR, 'trials.jsonl')),
        loadJsonlStrict(path.join(DATA_DIR, 'papers.jsonl')),
        loadJsonlStrict(path.join(DATA_DIR, 'bioactivities.jsonl')),
        loadJsonlStrict(path.join(DATA_DIR, 'compounds-enriched.jsonl')),
        loadJsonlStrict(path.join(DATA_DIR, 'negative-evidence-raw.jsonl')),
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

    resetBoxedWarningStats();
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
        else {
            // R2 fix ([[cross_cycle_silent_data_loss]]): the prior code counted
            // invalidCount but logged NO per-record reason -> a too-long
            // reason_text drop (or any drop) was SILENT. Log WHICH record + WHY
            // (excluded = scope fail-soft; otherwise a real validation drop).
            invalidCount++;
            const why = result.excluded
                ? `scope-excluded (${result.exclusion_reason})`
                : 'validation-failed';
            console.warn(`[NEG-BUILDER] DROPPED ${r.id} [${r.evidence_type}]: ${why}`);
        }
    }

    // PR-SID-1.7-pre.1: post-validation anchor enrichment for stamper.
    // buildNegAnchorPayload returns null only on parse failure (should never
    // happen post-validation since schema requires id + evidence_type); count
    // explicitly per [[cross_cycle_silent_data_loss]] defensive telemetry.
    let anchorMetadataAttached = 0;
    let anchorMetadataSkipped = 0;
    for (const r of validated) {
        const meta = buildNegAnchorPayload(r);
        if (meta) { Object.assign(r, meta); anchorMetadataAttached++; }
        else anchorMetadataSkipped++;
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
    console.log(`  Anchor metadata:         attached=${anchorMetadataAttached} | skipped=${anchorMetadataSkipped}`);
    // R5 LOUD one-but-not-other: how many compounds served the migrated
    // boxed_warnings[] vs the legacy single-text fallback (un-migrated).
    console.log(`  Boxed warnings:          migrated_array=${boxedWarningStats.migratedArray} | legacy_fallback=${boxedWarningStats.legacyFallback} | array_but_no_text=${boxedWarningStats.arrayButNoText}`);
}

main().catch(err => { console.error('[NEG-BUILDER] Fatal:', err); process.exit(1); });
