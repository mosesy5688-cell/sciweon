/**
 * Trial Results Enricher V0.3.5 — fill missing CT.gov Results section data.
 *
 * V0.3.4 trial-linker fetched search-endpoint records which lack full
 * ResultsSection. This step fills the gap: for each CT.gov trial in
 * trials.jsonl, fetch single-trial detail and extract signal-level results
 * (has_results / primary_outcomes / enrollment_actual / AE counts).
 *
 * Agent demand: "did this trial work?" — without results, Agent has a menu
 * with no prices. This is the #1 Agent-driven priority gap (2026-05-13).
 *
 * Pipeline position: runs after trial-linker. Operates in place on
 * output/linked/trials.jsonl. CTIS trials skipped (different API).
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchResultsByNctId } from '../ingestion/adapters/clinicaltrials-adapter.js';

const DATA_DIR = './output/linked';
const REQUEST_DELAY_MS = 200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

function isCtGovTrial(t) {
    // CT.gov uses NCT prefix; CTIS uses YYYY-NNNNNN-NN-NN format
    return /^NCT\d{8}$/.test(t.nct_id || '');
}

async function main() {
    console.log('[RESULTS-ENRICHER] V0.3.5 — fill CT.gov ResultsSection for existing trials');

    const file = path.join(DATA_DIR, 'trials.jsonl');
    const trials = await loadJsonl(file);
    console.log(`[RESULTS-ENRICHER] Loaded ${trials.length} trials`);

    const ctgovTrials = trials.filter(isCtGovTrial);
    console.log(`[RESULTS-ENRICHER] CT.gov trials (CTIS skipped): ${ctgovTrials.length}`);

    let processed = 0;
    let withResults = 0;
    let primaryOutcomeTotal = 0;
    let totalSeriousAe = 0;
    let trialsWithSeriousAe = 0;

    for (const t of ctgovTrials) {
        const signals = await fetchResultsByNctId(t.nct_id);
        if (signals) {
            t.results = signals;
            if (signals.has_results) {
                withResults++;
                primaryOutcomeTotal += signals.primary_outcomes.length;
                if (signals.serious_events_count > 0) {
                    trialsWithSeriousAe++;
                    totalSeriousAe += signals.serious_events_count;
                }
            }
        }
        processed++;
        if (processed % 50 === 0 || processed === ctgovTrials.length) {
            console.log(`[RESULTS-ENRICHER] ${processed}/${ctgovTrials.length} | has_results: ${withResults} | trials with AE: ${trialsWithSeriousAe}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    await writeJsonl(file, trials);

    console.log(`\n[RESULTS-ENRICHER] Complete`);
    console.log(`  CT.gov trials processed:        ${processed}`);
    console.log(`  With ResultsSection posted:     ${withResults} (${(100 * withResults / processed).toFixed(1)}%)`);
    console.log(`  Total primary outcomes:         ${primaryOutcomeTotal}`);
    console.log(`  Trials with serious AE records: ${trialsWithSeriousAe}`);
    console.log(`  Total serious AE records:       ${totalSeriousAe} (V0.4 NegEvidence Cat E raw)`);
}

main().catch(err => { console.error('[RESULTS-ENRICHER] Fatal:', err); process.exit(1); });
