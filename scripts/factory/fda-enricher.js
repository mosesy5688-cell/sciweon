/**
 * FDA Enricher V0.3.4 — openFDA drug labels + recalls per compound.
 *
 * For each compound with a FDA UNII (sourced V0.3.2 via UniChem), fetch
 * FDA drug label(s) + enforcement (recall) records. Aggregate to a
 * compact fda_signals object stamped on the compound.
 *
 * Pipeline position: runs after compound-id-resolver (which populates
 * external_ids.unii). Operates in place on compounds-enriched.jsonl.
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchLabelsByUnii, fetchRecallsByUnii, aggregateSignals, REQUEST_DELAY_MS } from '../ingestion/adapters/openfda-adapter.js';

const DATA_DIR = './output/linked';

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

async function main() {
    console.log('[FDA-ENRICHER] V0.3.4 — openFDA drug labels + recalls per compound');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[FDA-ENRICHER] Loaded ${compounds.length} compounds`);

    const withUnii = compounds.filter(c => c.external_ids?.unii);
    console.log(`[FDA-ENRICHER] Compounds with UNII (FDA-recognized): ${withUnii.length}`);

    let labelHit = 0;
    let recallHit = 0;
    let boxedWarning = 0;
    let processed = 0;

    for (const c of withUnii) {
        const unii = c.external_ids.unii;
        const labels = await fetchLabelsByUnii(unii, 5);
        await sleep(REQUEST_DELAY_MS);
        const recalls = await fetchRecallsByUnii(unii, 10);
        const signals = aggregateSignals(labels, recalls);
        if (signals) {
            c.fda_signals = signals;
            if (signals.label_count > 0) labelHit++;
            if (signals.recall_count > 0) recallHit++;
            if (signals.has_boxed_warning) boxedWarning++;
        }
        processed++;
        if (processed % 25 === 0 || processed === withUnii.length) {
            console.log(`[FDA-ENRICHER] ${processed}/${withUnii.length} | labels: ${labelHit} | recalls: ${recallHit} | boxed warnings: ${boxedWarning}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    await writeJsonl(file, compounds);

    console.log(`\n[FDA-ENRICHER] Complete`);
    console.log(`  Compounds with UNII processed: ${withUnii.length}`);
    console.log(`  With FDA drug label:           ${labelHit} (${(100 * labelHit / withUnii.length).toFixed(1)}%)`);
    console.log(`  With recall history:           ${recallHit}`);
    console.log(`  With boxed warning (Cat D NegEvidence): ${boxedWarning}`);
}

main().catch(err => { console.error('[FDA-ENRICHER] Fatal:', err); process.exit(1); });
