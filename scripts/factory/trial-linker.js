/**
 * Trial Linker V0.1 — links Compound → Clinical Trials.
 *
 * Strategy:
 *   1. Load enriched compounds (post cross-source-linker)
 *   2. For each compound with iupac_name or synonyms, query ClinicalTrials.gov
 *   3. Normalize matched trials, link via intervention name (compound_id hint)
 *   4. Track Negative Evidence raw data (TERMINATED/WITHDRAWN with whyStopped)
 *
 * Focus: V0.1a tests on compounds with max_phase >= 1 (proven clinical interest).
 *
 * Usage:
 *   node scripts/factory/trial-linker.js [--input=...] [--limit=50] [--clinical-only]
 *
 * Output:
 *   output/linked/trials.jsonl  — Trial entities
 *   output/linked/trial-links.jsonl — Compound → NCT ID associations
 *   output/linked/negative-evidence-raw.jsonl — TERMINATED/WITHDRAWN raw failure data
 */

import fs from 'fs/promises';
import path from 'path';
import { searchByIntervention, normalize as normalizeTrial } from '../ingestion/adapters/clinicaltrials-adapter.js';
import { TRIAL_SCHEMA } from '../../src/lib/schemas/trial.js';
import { gate } from './lib/validation-gate.js';
import { classifyBatch } from './lib/failure-classifier.js';
import { pickTrialSearchName } from './lib/trial-search-name.js';

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '50');
const INPUT = process.argv.find(a => a.startsWith('--input='))?.split('=')[1]
    || './output/linked/compounds-enriched.jsonl';
const CLINICAL_ONLY = process.argv.includes('--clinical-only');
const OUTPUT_DIR = './output/linked';
const REQUEST_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadCompounds(file) {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function main() {
    console.log(`[TRIAL-LINKER] V0.1 — input: ${INPUT}, limit: ${LIMIT}`);
    if (CLINICAL_ONLY) console.log(`[TRIAL-LINKER] Filter: only compounds with max_phase >= 1`);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    let compounds = await loadCompounds(INPUT);
    if (CLINICAL_ONLY) {
        compounds = compounds.filter(c => c.drug_status?.max_phase != null && c.drug_status.max_phase >= 1);
    }
    compounds = compounds.slice(0, LIMIT);
    console.log(`[TRIAL-LINKER] Processing ${compounds.length} compounds`);

    const allTrials = new Map(); // NCT ID → Trial entity (deduplicate across compounds)
    const trialLinks = []; // {compound_id, nct_id, intervention_name}
    const negativeEvidenceRaw = []; // failed trials with reasons
    const sourceCounts = {}; // {rxnorm_name: N, synonym: N, iupac_fallback: N, cid_fallback: N}

    let processedCompounds = 0;
    let totalTrialsFound = 0;
    let totalNegative = 0;

    for (const compound of compounds) {
        const { name: searchName, source: searchSource } = pickTrialSearchName(compound);
        sourceCounts[searchSource] = (sourceCounts[searchSource] ?? 0) + 1;
        const trials = await searchByIntervention(searchName, 100);

        for (const raw of trials) {
            const trial = normalizeTrial(raw, compound.id);
            if (!trial) continue;

            const result = gate(trial, TRIAL_SCHEMA, `trial:${trial.nct_id}`);
            if (!result.passed) continue;

            // Deduplicate (multiple compounds can match same trial)
            if (!allTrials.has(trial.nct_id)) {
                allTrials.set(trial.nct_id, trial);
                totalTrialsFound++;
                if (trial.is_negative_outcome) {
                    totalNegative++;
                    negativeEvidenceRaw.push({
                        nct_id: trial.nct_id,
                        compound_id: compound.id,
                        compound_name: searchName,
                        status: trial.status,
                        status_reason: trial.status_reason,
                        phase: trial.phase,
                        conditions: trial.conditions,
                    });
                }
            }
            trialLinks.push({
                compound_id: compound.id,
                nct_id: trial.nct_id,
                intervention_name: searchName,
            });
        }

        processedCompounds++;
        if (processedCompounds % 5 === 0 || processedCompounds === compounds.length) {
            console.log(`[TRIAL-LINKER] Progress: ${processedCompounds}/${compounds.length} compounds | ${totalTrialsFound} unique trials | ${totalNegative} negative outcomes`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    // Classify failures (V0.1 baseline keyword classifier)
    const classificationStats = classifyBatch(negativeEvidenceRaw);
    console.log(`\n[TRIAL-LINKER] Failure classification (V0.1 keyword baseline):`);
    for (const [cat, count] of Object.entries(classificationStats).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${cat.padEnd(12)} ${count}`);
    }

    // Write outputs
    const trialsFile = path.join(OUTPUT_DIR, 'trials.jsonl');
    const linksFile = path.join(OUTPUT_DIR, 'trial-links.jsonl');
    const negFile = path.join(OUTPUT_DIR, 'negative-evidence-raw.jsonl');

    await fs.writeFile(trialsFile, [...allTrials.values()].map(t => JSON.stringify(t)).join('\n'));
    await fs.writeFile(linksFile, trialLinks.map(l => JSON.stringify(l)).join('\n'));
    await fs.writeFile(negFile, negativeEvidenceRaw.map(n => JSON.stringify(n)).join('\n'));

    console.log(`\n[TRIAL-LINKER] ✅ Complete`);
    console.log(`  Compounds processed:      ${processedCompounds}`);
    console.log(`  Unique trials found:      ${totalTrialsFound}`);
    console.log(`  Compound-trial links:     ${trialLinks.length}`);
    console.log(`  Negative outcomes:        ${totalNegative} (${totalTrialsFound > 0 ? (100 * totalNegative / totalTrialsFound).toFixed(1) : 0}%) ⭐ V0.4 Negative Evidence raw data`);
    if (Object.keys(sourceCounts).length > 0) {
        console.log(`\n  Search-name source distribution (V0.5.6 high-leverage check):`);
        for (const [src, n] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${src.padEnd(16)} ${n}`);
        }
    }
    console.log(`\n  Outputs:`);
    console.log(`    ${trialsFile}`);
    console.log(`    ${linksFile}`);
    console.log(`    ${negFile}`);
}

main().catch(err => { console.error('[TRIAL-LINKER] Fatal:', err); process.exit(1); });
