/**
 * Compound Fingerprint Enricher V0.3.5 — PubChem CACTVS 881-bit keys.
 *
 * V0.3.5 Agent-driven priority #2: enable structural similarity search.
 * "Find compounds similar to X" is drug discovery's most basic operation.
 * Without fingerprints, Agent can only do name/ID match, not similarity.
 *
 * Implementation choice: PubChem CACTVS Substructure Keys (881-bit) over
 * RDKit Morgan circular fingerprint. CACTVS is NIH-computed primary data
 * (same authority class as XLogP/TPSA), zero local RDKit dependency,
 * batch-fetch via existing PubChem PUG-REST infrastructure.
 *
 * V0.5+ may add RDKit Morgan as second source for cross-validation
 * (cross-source consensus check — fingerprints can disagree across sources).
 *
 * Scale plan:
 *   V0.3.5: 5000 compounds × 156 base64 chars ≈ 0.8 MB     -> brute-force OK
 *   V0.1b:  111M  compounds × 156 base64 chars ≈ 17 GB     -> ANN index needed
 *
 * Pipeline position: runs after compound-id-resolver. In-place on
 * compounds-enriched.jsonl.
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchFingerprint2DBatch } from '../ingestion/adapters/pubchem-adapter.js';

const DATA_DIR = './output/linked';

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
    console.log('[FINGERPRINT-ENRICHER] V0.3.5 — PubChem CACTVS 881-bit keys');

    const file = path.join(DATA_DIR, 'compounds-enriched.jsonl');
    const compounds = await loadJsonl(file);
    console.log(`[FINGERPRINT-ENRICHER] Loaded ${compounds.length} compounds`);

    const cids = [];
    const compoundsByCid = new Map();
    for (const c of compounds) {
        if (c.pubchem_cid != null) {
            const cid = String(c.pubchem_cid);
            cids.push(cid);
            compoundsByCid.set(cid, c);
        }
    }
    console.log(`[FINGERPRINT-ENRICHER] Compounds with PubChem CID: ${cids.length}`);

    const t0 = Date.now();
    const fpMap = await fetchFingerprint2DBatch(cids, 100);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[FINGERPRINT-ENRICHER] Fetched ${fpMap.size} / ${cids.length} fingerprints in ${seconds}s`);

    let stamped = 0;
    for (const [cid, fp] of fpMap) {
        const compound = compoundsByCid.get(cid);
        if (!compound) continue;
        compound.fingerprint = {
            cactvs_881: fp,
            source: 'pubchem_cactvs_v2',
        };
        stamped++;
    }
    await writeJsonl(file, compounds);

    console.log(`\n[FINGERPRINT-ENRICHER] Complete`);
    console.log(`  Compounds stamped: ${stamped} / ${compounds.length} (${(100 * stamped / compounds.length).toFixed(1)}%)`);
    const sampleSize = fpMap.size > 0 ? [...fpMap.values()][0].length : 0;
    console.log(`  Fingerprint size:  ${sampleSize} chars base64 (881-bit CACTVS keys)`);
}

main().catch(err => { console.error('[FINGERPRINT-ENRICHER] Fatal:', err); process.exit(1); });
