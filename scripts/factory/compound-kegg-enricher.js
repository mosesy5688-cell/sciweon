/**
 * Compound KEGG Drug Enricher V0.3.5 #3 — drug-target-pathway network.
 *
 * For each Sciweon compound, search KEGG drug DB by primary synonym.
 * If matched: fetch full drug entry, parse PRIMARY-only fields, stamp
 * compound.kegg_drug with target genes / pathways / diseases / ATC codes.
 *
 * Expected hit rate: low CID compounds (1-1000) mostly basic chemicals,
 * not registered drugs. KEGG drug DB ~12K total drugs. Estimate 5-15%
 * coverage on current compound set; will rise sharply with V0.1b 111M.
 *
 * Match strategy: exact name match in KEGG search results' name list,
 * fallback to first hit if no exact match. KEGG name list includes
 * brand names + IUPAC + generic — try our compound's first synonym first.
 *
 * Pipeline position: runs after compound-id-resolver. In-place on
 * compounds-enriched.jsonl.
 */

import fs from 'fs/promises';
import path from 'path';
import { searchDrugByName, fetchDrugEntry, REQUEST_DELAY_MS } from '../ingestion/adapters/kegg-adapter.js';

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

function pickSearchName(compound) {
    if (compound.synonyms?.length) {
        // KEGG searches work better with short common names than IUPAC
        const short = compound.synonyms.find(s => s.length < 30);
        if (short) return short;
        return compound.synonyms[0];
    }
    if (compound.iupac_name && compound.iupac_name.length < 50) return compound.iupac_name;
    return null;
}

function findBestMatch(hits, queryName) {
    if (!hits.length) return null;
    const qLower = queryName.toLowerCase();
    // Prefer exact name match
    for (const hit of hits) {
        for (const name of hit.names) {
            if (name.toLowerCase() === qLower) return hit;
        }
    }
    // Fallback: first hit
    return hits[0];
}

function buildKeggDrugRecord(parsed) {
    if (!parsed?.d_number) return null;
    return {
        d_number: parsed.d_number,
        atc_codes: parsed.atc_codes,
        targets: parsed.targets,
        pathways: parsed.pathways,
        diseases: parsed.diseases,
    };
}

async function main() {
    console.log('[KEGG-ENRICHER] V0.3.5 #3 — drug-target-pathway network');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[KEGG-ENRICHER] Loaded ${compounds.length} compounds`);

    let processed = 0;
    let hit = 0;
    let withTargets = 0;
    let withPathways = 0;
    let withDiseases = 0;

    for (const c of compounds) {
        const name = pickSearchName(c);
        if (!name) { processed++; continue; }
        const hits = await searchDrugByName(name);
        await sleep(REQUEST_DELAY_MS);
        if (hits.length > 0) {
            const best = findBestMatch(hits, name);
            const entry = await fetchDrugEntry(best.d_number);
            await sleep(REQUEST_DELAY_MS);
            if (entry) {
                const record = buildKeggDrugRecord(entry);
                if (record) {
                    c.kegg_drug = record;
                    hit++;
                    if (record.targets.length > 0) withTargets++;
                    if (record.pathways.length > 0) withPathways++;
                    if (record.diseases.length > 0) withDiseases++;
                }
            }
        }
        processed++;
        if (processed % 50 === 0 || processed === compounds.length) {
            console.log(`[KEGG-ENRICHER] ${processed}/${compounds.length} | matched: ${hit} | targets: ${withTargets} | pathways: ${withPathways} | diseases: ${withDiseases}`);
        }
    }

    await writeJsonl(file, compounds);

    console.log(`\n[KEGG-ENRICHER] Complete`);
    console.log(`  Compounds processed:    ${processed}`);
    console.log(`  KEGG drug matched:      ${hit} (${(100 * hit / processed).toFixed(1)}%)`);
    console.log(`  With target genes:      ${withTargets}`);
    console.log(`  With pathways:          ${withPathways}`);
    console.log(`  With disease indications: ${withDiseases}`);
}

main().catch(err => { console.error('[KEGG-ENRICHER] Fatal:', err); process.exit(1); });
