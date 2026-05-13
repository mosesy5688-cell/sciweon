/**
 * Compound ID Resolver V0.3.2/0.3.3 — UniChem + RxNorm external canonical IDs.
 *
 * One UniChem call per compound returns FDA UNII / DrugBank ID / ChEBI ID /
 * KEGG_DRUG / HMDB ID keyed by InChIKey. UNII feeds the second hop to
 * NLM RxNav for RxNorm RXCUI + canonical name. Result: each compound
 * gains the international canonical ID set used by FDA / EMA / NLM /
 * hospital EHRs / regulatory systems.
 *
 * Pipeline position: runs after cross-source-linker (which produces
 * compounds-enriched.jsonl). Operates in place.
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchByInchiKey, REQUEST_DELAY_MS as UNICHEM_DELAY } from '../ingestion/adapters/unichem-adapter.js';
import { resolveByUnii } from '../ingestion/adapters/rxnorm-adapter.js';

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
    console.log('[ID-RESOLVER] V0.3.2/0.3.3 — UniChem + RxNorm canonical IDs');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[ID-RESOLVER] Loaded ${compounds.length} compounds`);

    let unichemHit = 0;
    let withUnii = 0;
    let withRxnorm = 0;
    const idStats = { drugbank_id: 0, chebi_id: 0, kegg_drug_id: 0, hmdb_id: 0 };
    let processed = 0;

    for (const c of compounds) {
        const inchiKey = c.inchi_key;
        if (!inchiKey) { processed++; continue; }

        const xrefs = await fetchByInchiKey(inchiKey);
        const external = { sources: [] };
        if (xrefs) {
            unichemHit++;
            external.sources.push('unichem');
            for (const [k, v] of Object.entries(xrefs)) {
                if (k === 'chembl_id' || k === 'pubchem_cid') continue; // already on entity
                external[k] = v;
                if (k === 'unii') withUnii++;
                if (k in idStats) idStats[k]++;
            }
        }
        await sleep(UNICHEM_DELAY);

        if (external.unii) {
            const rxnorm = await resolveByUnii(external.unii);
            if (rxnorm && rxnorm.rxcui) {
                external.rxcui = rxnorm.rxcui;
                if (rxnorm.rxnorm_name) external.rxnorm_name = rxnorm.rxnorm_name;
                if (rxnorm.tty) external.rxnorm_tty = rxnorm.tty;
                external.sources.push('rxnorm');
                withRxnorm++;
            }
            await sleep(150);
        }

        if (external.sources.length > 0) c.external_ids = external;
        processed++;
        if (processed % 25 === 0 || processed === compounds.length) {
            console.log(`[ID-RESOLVER] ${processed}/${compounds.length} | UniChem hit: ${unichemHit} | UNII: ${withUnii} | RXCUI: ${withRxnorm}`);
        }
    }

    await writeJsonl(file, compounds);

    console.log(`\n[ID-RESOLVER] Complete`);
    console.log(`  Compounds processed:       ${compounds.length}`);
    console.log(`  UniChem cross-ref hit:     ${unichemHit} (${(100 * unichemHit / compounds.length).toFixed(1)}%)`);
    console.log(`  With FDA UNII:             ${withUnii} (${(100 * withUnii / compounds.length).toFixed(1)}%)`);
    console.log(`  With RxNorm RXCUI:         ${withRxnorm} (${(100 * withRxnorm / compounds.length).toFixed(1)}%)`);
    console.log(`  Other canonical IDs gained:`);
    for (const [k, v] of Object.entries(idStats)) console.log(`    ${k.padEnd(15)} ${v}`);
}

main().catch(err => { console.error('[ID-RESOLVER] Fatal:', err); process.exit(1); });
