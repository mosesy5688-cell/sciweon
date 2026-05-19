/**
 * ChEMBL Compound Enricher — Stage 2 enricher.
 *
 * V0.5.7 (H2b-4): batched `__in=` InChIKey lookup + R2-persisted negative
 * cache. Previous singleton-per-compound loop was the dominant component
 * of the 4h34m stage-2 wall time; batching collapses 5K HTTP calls to
 * ~100, and the cross-run negative cache skips known-no-match keys
 * entirely.
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
 * Skips compounds that already have chembl_id (idempotent for re-runs).
 *
 * Cache file `./output/linked/chembl-negative-cache.json` is downloaded
 * before this script by stage-2-process.js (via lib/r2-cache-bridge.js)
 * and re-uploaded after.
 */

import fs from 'fs/promises';
import path from 'path';
import { findByInchiKeyBatch, normalizeDrugStatus } from '../ingestion/adapters/chembl-adapter.js';
import { scoreEntity } from './lib/confidence-scorer.js';
import {
    loadNegativeCache, saveNegativeCache, partitionInchiKeys,
} from './lib/chembl-negative-cache.js';

const DATA_DIR = './output/linked';
const CACHE_FILE = path.join(DATA_DIR, 'chembl-negative-cache.json');

async function loadJsonl(file) {
    try {
        const c = await fs.readFile(file, 'utf-8');
        return c.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
}

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

function applyEnrichment(c, mol) {
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
}

async function main() {
    console.log('[CHEMBL-ENRICHER] V0.5.7 — batch InChIKey lookup + negative cache');
    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[CHEMBL-ENRICHER] Loaded ${compounds.length} compounds`);

    const negativeCache = await loadNegativeCache(CACHE_FILE);
    const cacheSizeBefore = negativeCache.size;

    const todo = compounds.filter(c => c.inchi_key && !c.chembl_id);
    const noInchiKey = compounds.filter(c => !c.inchi_key).length;
    const alreadyHas = compounds.filter(c => c.inchi_key && c.chembl_id).length;

    const { toQuery, cachedNegatives } = partitionInchiKeys(
        todo.map(c => c.inchi_key), negativeCache,
    );
    console.log(`[CHEMBL-ENRICHER] ${todo.length} need lookup; ${cachedNegatives.length} skip via cache; ${toQuery.length} to ChEMBL`);

    const resultMap = await findByInchiKeyBatch(toQuery);

    let hit = 0;
    let noMatch = cachedNegatives.length;
    for (const c of todo) {
        if (negativeCache.has(c.inchi_key)) continue;
        const mol = resultMap.get(c.inchi_key);
        if (!mol) {
            negativeCache.add(c.inchi_key);
            noMatch++;
            continue;
        }
        applyEnrichment(c, mol);
        hit++;
    }

    await writeJsonl(file, compounds);
    await saveNegativeCache(CACHE_FILE, negativeCache);
    console.log(`[CHEMBL-ENRICHER] Complete: ${hit} enriched | ${noMatch} no ChEMBL match | ${noInchiKey} no InChIKey | ${alreadyHas} already-had-ID | cache ${cacheSizeBefore} -> ${negativeCache.size}`);
}

main().catch(err => { console.error('[CHEMBL-ENRICHER] Fatal:', err); process.exit(1); });
