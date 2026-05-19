/**
 * V0.5.7 — ChEMBL InChIKey negative cache.
 *
 * Stage-2 ChEMBL enricher historically issued one HTTP request per compound
 * to ChEMBL's molecule resource — even for compounds that returned no match
 * last cycle, and the cycle before, ad infinitum. Most PubChem CIDs are not
 * in ChEMBL, so the repeated-negative-lookup workload dominated the
 * 4h34m stage-2 wall time.
 *
 * This helper persists the set of "ChEMBL has no match for InChIKey X"
 * results across runs (via R2, wired by stage-2-process.js) so subsequent
 * enricher runs skip known negatives entirely.
 *
 * Pure surface: `partitionInchiKeys` is the testable decision function.
 * `loadNegativeCache` / `saveNegativeCache` are thin local I/O wrappers
 * (cross-run persistence is owned by lib/r2-cache-bridge.js).
 */

import fs from 'fs/promises';

export async function loadNegativeCache(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const j = JSON.parse(raw);
        if (Array.isArray(j?.inchikeys)) return new Set(j.inchikeys);
        return new Set();
    } catch (err) {
        if (err.code === 'ENOENT') return new Set();
        throw err;
    }
}

export async function saveNegativeCache(filePath, set) {
    const payload = {
        version: 1,
        last_updated: new Date().toISOString(),
        inchikeys: [...set].sort(),
    };
    await fs.writeFile(filePath, JSON.stringify(payload));
}

export function partitionInchiKeys(inchikeys, negativeSet) {
    const toQuery = [];
    const cachedNegatives = [];
    if (!Array.isArray(inchikeys)) return { toQuery, cachedNegatives };
    const neg = negativeSet ?? new Set();
    for (const k of inchikeys) {
        if (!k) continue;
        if (neg.has(k)) cachedNegatives.push(k);
        else toQuery.push(k);
    }
    return { toQuery, cachedNegatives };
}
