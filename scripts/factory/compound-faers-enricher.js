/**
 * Compound FAERS Enricher V0.4.1 — quantified safety signals.
 *
 * Agent demand: "compound X has N hepatotoxicity reports" requires
 * signal-level FAERS aggregation, not 24M individual records. openFDA
 * `count=patient.reaction.reactionmeddrapt.exact` returns top ADR terms
 * with FAERS report counts in a single API call.
 *
 * V0.4 design: NegEvidence Cat E (adverse events) covered in signal-level
 * form (top ADR terms + report counts). Full per-report data deferred
 * indefinitely (24M records, not needed for Agent decision).
 *
 * Pipeline position: runs after fda-enricher (which produces fda_signals).
 * Extends compound.fda_signals with faers_top_adr_terms.
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchFaersSignalsByUnii, REQUEST_DELAY_MS } from '../ingestion/adapters/openfda-adapter.js';

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
    console.log('[FAERS-ENRICHER] V0.4.1 — quantified FAERS safety signals');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[FAERS-ENRICHER] Loaded ${compounds.length} compounds`);

    const withUnii = compounds.filter(c => c.external_ids?.unii);
    console.log(`[FAERS-ENRICHER] UNII-bearing compounds: ${withUnii.length}`);

    let withFaersData = 0;
    let totalAdrTerms = 0;
    let totalReports = 0;
    let processed = 0;
    let topReport = { term: '', count: 0, compound: null };

    for (const c of withUnii) {
        const signals = await fetchFaersSignalsByUnii(c.external_ids.unii, 30);
        if (signals.length > 0) {
            const totalCount = signals.reduce((s, r) => s + r.count, 0);
            // Augment existing fda_signals object (V0.3.4 fda-enricher stamps base)
            c.fda_signals = c.fda_signals ?? { sources: [] };
            c.fda_signals.faers_top_adr_terms = signals.slice(0, 30);
            c.fda_signals.faers_total_top_count = totalCount;
            if (!c.fda_signals.sources?.includes('openfda_faers')) {
                c.fda_signals.sources = [...(c.fda_signals.sources ?? []), 'openfda_faers'];
            }
            withFaersData++;
            totalAdrTerms += signals.length;
            totalReports += totalCount;
            // Track most reported single ADR across all compounds for sanity check
            for (const s of signals) {
                if (s.count > topReport.count) {
                    topReport = { term: s.term, count: s.count, compound: c.synonyms?.[0] || c.pubchem_cid };
                }
            }
        }
        processed++;
        if (processed % 25 === 0 || processed === withUnii.length) {
            console.log(`[FAERS-ENRICHER] ${processed}/${withUnii.length} | with FAERS: ${withFaersData} | total reports: ${totalReports.toLocaleString()}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    await writeJsonl(file, compounds);

    console.log(`\n[FAERS-ENRICHER] Complete`);
    console.log(`  UNII compounds processed:      ${withUnii.length}`);
    console.log(`  With FAERS data:               ${withFaersData} (${(100 * withFaersData / withUnii.length).toFixed(1)}%)`);
    console.log(`  Total top-30 ADR terms stored: ${totalAdrTerms}`);
    console.log(`  Total FAERS reports captured:  ${totalReports.toLocaleString()}`);
    console.log(`  Most-reported single signal:   ${topReport.term} (${topReport.count.toLocaleString()}) for ${topReport.compound}`);
}

main().catch(err => { console.error('[FAERS-ENRICHER] Fatal:', err); process.exit(1); });
