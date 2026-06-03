/**
 * Target Resolver V0.2.2 — cross-source Bioactivity.target metadata.
 *
 * Bioactivity is single-source (ChEMBL) for the measurement itself, but the
 * target context can be cross-validated against UniProt (international
 * protein authority, EMBL-EBI). This step enriches each bioactivity record
 * with a target metadata object sourced from ChEMBL + UniProt.
 *
 * Pipeline position: runs after cross-source-linker / paper-linker, before
 * agent-simulator. Operates in place on output/linked/bioactivities.jsonl.
 *
 * Steps:
 *   1. Load bioactivities.jsonl
 *   2. Collect unique target_chembl_id values
 *   3. For each ChEMBL target -> ChEMBL /target/{id} -> extract UniProt accessions
 *   4. Batch-fetch UniProt accessions (100 per call)
 *   5. Build target metadata map keyed by ChEMBL target ID
 *   6. Stamp `bioactivity.target = { ... sources: [...] }` on each record
 *   7. Save bioactivities.jsonl
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchTargetByChemblId, extractTargetPrimary } from '../ingestion/adapters/chembl-adapter.js';
import { fetchByAccessionBatch, extractPrimary as uniprotExtractPrimary } from '../ingestion/adapters/uniprot-adapter.js';
import { loadJsonlStrict } from './lib/jsonl-io.js';

const DATA_DIR = './output/linked';
const REQUEST_DELAY_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

async function resolveChemblTargets(chemblTargetIds) {
    const targetMap = new Map(); // chembl_id -> chembl primary metadata
    const allAccessions = new Set();
    let processed = 0;
    let withAccession = 0;

    for (const chemblId of chemblTargetIds) {
        const raw = await fetchTargetByChemblId(chemblId);
        if (raw) {
            const primary = extractTargetPrimary(raw);
            if (primary) {
                targetMap.set(chemblId, primary);
                if (primary.uniprot_accessions.length > 0) {
                    withAccession++;
                    for (const acc of primary.uniprot_accessions) allAccessions.add(acc);
                }
            }
        }
        processed++;
        if (processed % 50 === 0 || processed === chemblTargetIds.length) {
            console.log(`[TARGET-RESOLVER] ChEMBL: ${processed}/${chemblTargetIds.length} | with UniProt accession: ${withAccession}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }
    return { targetMap, allAccessions };
}

function mergeUniprotIntoTargets(targetMap, uniprotMap) {
    let crossVerified = 0;
    for (const [chemblId, primary] of targetMap) {
        const sources = ['chembl'];
        let uniprotPrimary = null;
        for (const acc of primary.uniprot_accessions) {
            const raw = uniprotMap.get(acc);
            if (raw) {
                uniprotPrimary = uniprotExtractPrimary(raw);
                if (uniprotPrimary) break; // first match wins
            }
        }
        if (uniprotPrimary) {
            sources.push('uniprot');
            crossVerified++;
            primary._merged = {
                uniprot_accession: uniprotPrimary.uniprot_accession,
                uniprot_id: uniprotPrimary.uniprot_id,
                protein_name: uniprotPrimary.protein_name,
                organism: uniprotPrimary.organism,
                gene_symbol: uniprotPrimary.gene_symbol,
                sequence_length: uniprotPrimary.sequence_length,
                sequence_mol_weight: uniprotPrimary.sequence_mol_weight,
            };
        }
        primary._sources = sources;
    }
    return crossVerified;
}

function stampTargetOnBioactivity(bioactivity, targetMap) {
    const chemblTargetId = bioactivity.target_id;
    if (!chemblTargetId || chemblTargetId === 'unknown') return false;
    const primary = targetMap.get(chemblTargetId);
    if (!primary) return false;
    const target = {
        chembl_id: primary.chembl_id,
        chembl_pref_name: primary.chembl_pref_name,
        target_type: primary.target_type,
        sources: primary._sources,
    };
    if (primary._merged) {
        Object.assign(target, primary._merged);
    } else if (primary.chembl_organism) {
        // Single-source (ChEMBL only) — populate organism from ChEMBL fallback
        target.organism = {
            taxon_id: primary.chembl_tax_id,
            scientific_name: primary.chembl_organism,
        };
    }
    bioactivity.target = target;
    return true;
}

async function main() {
    console.log('[TARGET-RESOLVER] V0.2.2 — cross-source target metadata');

    const bioFile = path.join(DATA_DIR, 'bioactivities.jsonl');
    const bioacts = await loadJsonlStrict(bioFile);
    console.log(`[TARGET-RESOLVER] Loaded ${bioacts.length} bioactivities`);

    const uniqueChemblTargets = [...new Set(bioacts
        .map(b => b.target_id)
        .filter(t => t && t !== 'unknown'))];
    console.log(`[TARGET-RESOLVER] Unique ChEMBL targets: ${uniqueChemblTargets.length}`);

    const { targetMap, allAccessions } = await resolveChemblTargets(uniqueChemblTargets);
    console.log(`[TARGET-RESOLVER] ChEMBL targets resolved: ${targetMap.size} | unique UniProt accessions: ${allAccessions.size}`);

    const uniprotMap = await fetchByAccessionBatch([...allAccessions]);
    console.log(`[TARGET-RESOLVER] UniProt batch fetched: ${uniprotMap.size} / ${allAccessions.size}`);

    const crossVerified = mergeUniprotIntoTargets(targetMap, uniprotMap);
    console.log(`[TARGET-RESOLVER] Cross-source verified targets: ${crossVerified} / ${targetMap.size}`);

    let stamped = 0;
    for (const b of bioacts) {
        if (stampTargetOnBioactivity(b, targetMap)) stamped++;
    }
    await writeJsonl(bioFile, bioacts);

    console.log(`\n[TARGET-RESOLVER] Complete`);
    console.log(`  Bioactivities stamped:       ${stamped} / ${bioacts.length}`);
    console.log(`  Cross-source verified (ChEMBL+UniProt): ${crossVerified} targets`);
    console.log(`  Single-source (ChEMBL only): ${targetMap.size - crossVerified} targets`);
}

main().catch(err => { console.error('[TARGET-RESOLVER] Fatal:', err); process.exit(1); });
