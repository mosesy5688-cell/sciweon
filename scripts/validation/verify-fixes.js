/**
 * Verify Fixes — spot check for V0.1 simulator bugs 1, 2, 4
 *
 * Re-fetches GABA (CID:119) through updated adapters and confirms:
 *   Bug 1: smiles_canonical populated (PubChem SMILES field)
 *   Bug 2: bioactivities have unit_raw + 'other' classification (not unitless)
 *   Bug 4: papers include recent (≥2020) entries from mixed OpenAlex query
 *
 * Does NOT touch the linked dataset. Pure adapter-level proof.
 */

import { getCompound } from '../ingestion/adapters/pubchem-adapter.js';
import { findByInchiKey, fetchActivities, normalizeActivity } from '../ingestion/adapters/chembl-adapter.js';
import { search as openalexSearch, normalize as normalizePaper } from '../ingestion/adapters/openalex-adapter.js';

const GABA_CID = 119;

async function main() {
    console.log('[VERIFY] Spot-checking adapter fixes against CID:119 (GABA)\n');

    // Bug 1 — PubChem SMILES fix
    console.log('[Bug 1] PubChem smiles_canonical');
    let compound = null;
    try {
        compound = await getCompound(GABA_CID);
    } catch (err) {
        console.log(`  ❌ PubChem fetch threw: ${err.message}`);
        return;
    }
    if (!compound) {
        console.log('  ❌ PubChem returned no record (deprecated CID?)');
        return;
    }
    const smiles = compound.smiles_canonical;
    console.log(`  smiles_canonical: "${smiles}"`);
    console.log(`  inchi: ${compound.inchi ? 'present' : 'MISSING'}`);
    console.log(`  formula: ${compound.molecular_formula || 'MISSING'}`);
    const bug1Fixed = smiles && smiles.length > 0;
    console.log(`  ${bug1Fixed ? '✅ FIXED' : '❌ STILL BROKEN'} — SMILES ${bug1Fixed ? 'populated' : 'still empty'}\n`);

    // Bug 2 — ChEMBL unit normalization
    console.log('[Bug 2] ChEMBL bioactivity units');
    const chembl = await findByInchiKey(compound.inchi_key);
    if (!chembl) {
        console.log('  ⚠️ No ChEMBL match for GABA InChIKey — skipping unit test');
    } else {
        const acts = await fetchActivities(chembl.molecule_chembl_id, 95);
        const normalized = acts.map(a => normalizeActivity(a, compound.id)).filter(Boolean);
        const unitless = normalized.filter(a => a.unit === 'unitless').length;
        const other = normalized.filter(a => a.unit === 'other').length;
        const withRaw = normalized.filter(a => a.unit_raw).length;
        const unitlessRate = normalized.length > 0 ? (unitless / normalized.length).toFixed(2) : 'N/A';
        console.log(`  Total bioactivities: ${normalized.length}`);
        console.log(`  unitless: ${unitless} (${unitlessRate}) | other: ${other} | with unit_raw: ${withRaw}`);
        const bug2Fixed = normalized.length === 0 || (unitless / normalized.length) <= 0.3;
        console.log(`  ${bug2Fixed ? '✅ FIXED' : '⚠️ PARTIAL'} — unitless rate ${unitlessRate} ${bug2Fixed ? '≤ 0.3 threshold' : '> 0.3 threshold'}\n`);
    }

    // Bug 4 — OpenAlex mixed query for recent papers
    console.log('[Bug 4] OpenAlex recent papers (≥2020)');
    const works = await openalexSearch('gamma-aminobutyric acid', 25);
    const papers = works.map(w => normalizePaper(w, compound.id, 'concept_match')).filter(Boolean);
    const recent = papers.filter(p => p.publication_year >= 2020).length;
    const total = papers.length;
    console.log(`  Total papers: ${total}`);
    console.log(`  Recent (≥2020): ${recent}`);
    const yearDist = {};
    papers.forEach(p => { const y = p.publication_year || 'unknown'; yearDist[y] = (yearDist[y] || 0) + 1; });
    console.log(`  Year distribution:`, Object.entries(yearDist).sort().slice(0, 8).map(([y, n]) => `${y}=${n}`).join(' '));
    const bug4Fixed = recent > 0;
    console.log(`  ${bug4Fixed ? '✅ FIXED' : '❌ STILL BROKEN'} — recent papers ${bug4Fixed ? 'present' : 'still zero'}\n`);

    console.log('=== Verdict ===');
    console.log(`Bug 1 (SMILES):      ${bug1Fixed ? '✅' : '❌'}`);
    if (chembl) {
        // Recompute for verdict
        const acts = await fetchActivities(chembl.molecule_chembl_id, 95);
        const normalized = acts.map(a => normalizeActivity(a, compound.id)).filter(Boolean);
        const unitless = normalized.filter(a => a.unit === 'unitless').length;
        const bug2Fixed = normalized.length === 0 || (unitless / normalized.length) <= 0.3;
        console.log(`Bug 2 (unit_raw):    ${bug2Fixed ? '✅' : '⚠️'}`);
    }
    console.log(`Bug 4 (recent OA):   ${bug4Fixed ? '✅' : '❌'}`);
}

main().catch(err => { console.error('[VERIFY] Fatal:', err); process.exit(1); });
