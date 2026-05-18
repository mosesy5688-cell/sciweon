/**
 * ChEMBL Compound Enricher — Stage 2 enricher.
 *
 * Resolves chembl_id and drug_status for each compound by InChIKey lookup
 * against the ChEMBL REST API. Feeds the fields that downstream enrichers
 * and the confidence scorer depend on:
 *   compound.chembl_id              (molecule_chembl_id)
 *   compound.drug_status            (max_phase, first_approval_year, withdrawn, ...)
 *   compound.provenance.sources     (+chembl entry)
 *   compound.confidence             (recomputed via scoreEntity — 60->80+ with 2 sources)
 *
 * Pipeline position: after fingerprint+kegg, before compound-id-resolver.
 * Order matters: compound-id-resolver reads inchi_key (not chembl_id), so
 * either order is safe; placing here first so drug_status is available for
 * any downstream enricher that gates on it.
 *
 * Skips compounds that already have chembl_id (idempotent for re-runs).
 */

import fs from 'fs/promises';
import path from 'path';
import { findByInchiKey, normalizeDrugStatus } from '../ingestion/adapters/chembl-adapter.js';
import { scoreEntity } from './lib/confidence-scorer.js';

const DATA_DIR = './output/linked';
const REQUEST_DELAY_MS = 300; // ChEMBL public: ~5 req/sec; 300ms stays safely under
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
    console.log('[CHEMBL-ENRICHER] V0.1 — ChEMBL compound lookup by InChIKey');
    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[CHEMBL-ENRICHER] Loaded ${compounds.length} compounds`);

    let hit = 0, noMatch = 0, noInchiKey = 0, alreadyHas = 0;

    for (const c of compounds) {
        if (!c.inchi_key) { noInchiKey++; continue; }
        if (c.chembl_id) { alreadyHas++; continue; }

        const mol = await findByInchiKey(c.inchi_key);
        if (!mol) {
            noMatch++;
            await sleep(REQUEST_DELAY_MS);
            continue;
        }

        c.chembl_id = mol.molecule_chembl_id;

        const ds = normalizeDrugStatus(mol);
        if (ds && (ds.max_phase != null || ds.withdrawn || ds.black_box_warning)) {
            c.drug_status = ds;
        }

        const ts = new Date().toISOString();
        const chemblInchiKey = mol.molecule_structures?.standard_inchi_key;
        const structuralMatch = chemblInchiKey === c.inchi_key;

        if (!Array.isArray(c.provenance?.sources)) {
            c.provenance = { sources: [], last_updated: ts };
        }
        c.provenance.sources.push({
            source: 'chembl',
            source_id: mol.molecule_chembl_id,
            timestamp: ts,
            extraction_method: 'chembl_rest_v1_inchikey_lookup',
        });
        c.provenance.last_updated = ts;

        c.confidence = {
            ...c.confidence,
            cross_source_agreement: {
                structural_match: structuralMatch,
                conflicts: structuralMatch ? [] : ['inchi_key mismatch between pubchem and chembl'],
            },
        };
        const scored = scoreEntity(c);
        Object.assign(c.confidence, scored);

        hit++;
        await sleep(REQUEST_DELAY_MS);
        if ((hit + noMatch) % 50 === 0) {
            console.log(`[CHEMBL-ENRICHER] progress: hit=${hit} noMatch=${noMatch} noInchiKey=${noInchiKey}`);
        }
    }

    await writeJsonl(file, compounds);
    console.log(`[CHEMBL-ENRICHER] Complete: ${hit} enriched | ${noMatch} no ChEMBL match | ${noInchiKey} no InChIKey | ${alreadyHas} skipped (already had ID)`);
}

main().catch(err => { console.error('[CHEMBL-ENRICHER] Fatal:', err); process.exit(1); });
