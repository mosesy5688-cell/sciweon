/**
 * CTIS Trial Linker V0.3.4 — EU CTIS as Trial 2nd source.
 *
 * For each clinical-relevant compound, search CTIS by product/synonym name.
 * Matching trials are normalized to Sciweon Trial schema with source='ctis'
 * and appended to trials.jsonl. CTIS trials use the EU canonical ctNumber
 * (different ID space from CT.gov NCT IDs); cross-link via EUDRA-CT bridge
 * is deferred to V0.4.
 *
 * Pipeline position: runs after trial-linker (CT.gov) on the same compounds
 * input. Appends to trials.jsonl + trial-links.jsonl.
 */

import fs from 'fs/promises';
import path from 'path';
import { searchByQuery, normalizeToTrial, REQUEST_DELAY_MS } from '../ingestion/adapters/ctis-adapter.js';
import { TRIAL_SCHEMA } from '../../src/lib/schemas/trial.js';
import { gate } from './lib/validation-gate.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '50');
const INPUT = process.argv.find(a => a.startsWith('--input='))?.split('=')[1]
    || './output/linked/compounds-enriched.jsonl';
const OUTPUT_DIR = './output/linked';
const TRIALS_PER_COMPOUND = 30;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function appendJsonl(file, records) {
    if (records.length === 0) return;
    const lines = records.map(r => JSON.stringify(r)).join('\n');
    await fs.appendFile(file, '\n' + lines);
}

function pickSearchName(compound) {
    return compound.synonyms?.[0] || compound.iupac_name?.split(' ')[0] || null;
}

async function main() {
    console.log(`[CTIS-LINKER] V0.3.4 — EU CTIS as Trial 2nd source`);

    const compounds = (await loadJsonlStrict(INPUT))
        .filter(c => c.drug_status?.max_phase != null && c.drug_status.max_phase >= 1)
        .slice(0, LIMIT);
    console.log(`[CTIS-LINKER] Clinical-only compounds: ${compounds.length}`);

    const existingTrials = await loadJsonlStrict(path.join(OUTPUT_DIR, 'trials.jsonl'));
    const existingCtNumbers = new Set(existingTrials
        .filter(t => t.ct_number)
        .map(t => t.ct_number));
    console.log(`[CTIS-LINKER] Existing CTIS trials in trials.jsonl: ${existingCtNumbers.size}`);

    const newTrials = [];
    const newLinks = [];
    let totalFound = 0;
    let totalAccepted = 0;
    let processed = 0;
    // PR-TRIAL-ISOLATION: bucket scope-excluded (oversized legitimate text) trials
    // so the fail-soft skip is observable instead of silent.
    const tele = { excluded_oversized: 0, sample_excluded: [] };

    for (const compound of compounds) {
        const searchName = pickSearchName(compound);
        if (!searchName) { processed++; continue; }

        const raws = await searchByQuery(searchName, TRIALS_PER_COMPOUND);
        for (const raw of raws) {
            if (!raw.ctNumber || existingCtNumbers.has(raw.ctNumber)) continue;
            const trial = normalizeToTrial(raw, compound.id);
            if (!trial) continue;
            const result = gate(trial, TRIAL_SCHEMA, `trial:${trial.ct_number}`);
            if (!result.passed) {
                if (result.excluded) {
                    tele.excluded_oversized++;
                    if (tele.sample_excluded.length < 10) {
                        tele.sample_excluded.push(`${trial.ct_number} (${result.exclusion_reason})`);
                    }
                }
                continue;
            }
            newTrials.push(trial);
            existingCtNumbers.add(trial.ct_number);
            newLinks.push({
                compound_id: compound.id,
                nct_id: trial.ct_number,
                intervention_name: searchName,
            });
            totalAccepted++;
        }
        totalFound += raws.length;
        processed++;
        if (processed % 5 === 0 || processed === compounds.length) {
            console.log(`[CTIS-LINKER] ${processed}/${compounds.length} | CTIS matches: ${totalFound} | new accepted: ${totalAccepted}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    await appendJsonl(path.join(OUTPUT_DIR, 'trials.jsonl'), newTrials);
    await appendJsonl(path.join(OUTPUT_DIR, 'trial-links.jsonl'), newLinks);

    console.log(`\n[CTIS-LINKER] Complete`);
    console.log(`  Compounds queried:       ${processed}`);
    console.log(`  CTIS raw matches:        ${totalFound}`);
    console.log(`  Schema-valid + new:      ${totalAccepted}`);
    console.log(`  Total EU trials added:   ${newTrials.length}`);
    if (tele.excluded_oversized > 0) {
        console.log(`[CTIS-LINKER] scope-excluded oversized trials: ${tele.excluded_oversized} | sample: ${tele.sample_excluded.join(', ')}`);
    }
    console.log(`  Compound-trial links:    ${newLinks.length}`);
}

main().catch(err => { console.error('[CTIS-LINKER] Fatal:', err); process.exit(1); });
