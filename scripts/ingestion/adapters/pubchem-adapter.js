/**
 * PubChem Adapter — Sciweon V0.1
 *
 * Fetches compound data from PubChem PUG-REST API and normalizes to Sciweon
 * Compound schema (V8 strict contract).
 *
 * Rate limit: 5 req/sec anonymous (higher with API key).
 * API docs: https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest
 *
 * V0.1a usage: small-scale (1000 compounds) for schema validation.
 * V0.1b: scale via Bulk FTP, not this adapter.
 */

import { computeLipinskiViolations } from '../../factory/lib/lipinski.js';
import { scoreEntity } from '../../factory/lib/confidence-scorer.js';

const PUBCHEM_BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const REQUEST_TIMEOUT_MS = 15000;
// PubChem deprecated CanonicalSMILES → SMILES (2025+). Request both for compatibility.
const PROPERTIES = [
    'MolecularFormula', 'MolecularWeight', 'IUPACName', 'InChI', 'InChIKey',
    'SMILES', 'CanonicalSMILES', 'IsomericSMILES', 'XLogP', 'ExactMass', 'TPSA',
    'Complexity', 'HBondDonorCount', 'HBondAcceptorCount', 'RotatableBondCount',
].join(',');

async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

/**
 * Fetch raw PubChem data for a single CID.
 */
export async function fetchCompound(cid) {
    const url = `${PUBCHEM_BASE}/compound/cid/${cid}/property/${PROPERTIES}/JSON`;
    const data = await fetchJson(url);
    return data?.PropertyTable?.Properties?.[0] ?? null;
}

/**
 * Fetch synonyms for a CID (separate endpoint).
 */
export async function fetchSynonyms(cid) {
    try {
        const url = `${PUBCHEM_BASE}/compound/cid/${cid}/synonyms/JSON`;
        const data = await fetchJson(url);
        return data?.InformationList?.Information?.[0]?.Synonym?.slice(0, 100) ?? [];
    } catch { return []; }
}

/**
 * Normalize raw PubChem record → Sciweon Compound schema.
 */
export function normalize(raw, synonyms = []) {
    if (!raw || !raw.InChIKey) return null;

    const properties = {
        log_p: raw.XLogP != null ? { value: raw.XLogP, method: 'XLogP3' } : null,
        tpsa: raw.TPSA != null ? { value: raw.TPSA, unit: 'angstrom_squared' } : null,
        complexity: raw.Complexity ?? null,
        h_bond_donors: raw.HBondDonorCount ?? null,
        h_bond_acceptors: raw.HBondAcceptorCount ?? null,
        rotatable_bonds: raw.RotatableBondCount ?? null,
    };
    properties.lipinski_violations = computeLipinskiViolations(properties, raw.MolecularWeight);

    const timestamp = new Date().toISOString();

    const entity = {
        id: `sciweon::compound::CID:${raw.CID}`,
        pubchem_cid: raw.CID,
        chembl_id: null,
        inchi_key: raw.InChIKey,
        smiles_canonical: raw.SMILES ?? raw.CanonicalSMILES ?? raw.IsomericSMILES ?? '',
        inchi: raw.InChI ?? '',
        molecular_formula: raw.MolecularFormula ?? '',
        molecular_weight: {
            value: typeof raw.MolecularWeight === 'string' ? parseFloat(raw.MolecularWeight) : raw.MolecularWeight,
            unit: 'Da',
        },
        iupac_name: raw.IUPACName ?? null,
        synonyms: synonyms,
        properties,
        drug_status: null,
        provenance: {
            sources: [{
                source: 'pubchem',
                source_id: String(raw.CID),
                timestamp,
                extraction_method: 'pubchem_pug_rest_v1',
            }],
            last_updated: timestamp,
        },
        confidence: { cross_source_agreement: { structural_match: false, conflicts: [] } },
        stats: {
            paper_count: 0,
            trial_count_active: 0,
            trial_count_terminated: 0,
            bioactivity_count_active: 0,
            bioactivity_count_inactive: 0,
        },
    };
    // Compute confidence consistently via scoreEntity (single-source baseline)
    entity.confidence = scoreEntity(entity);
    return entity;
}

/**
 * Batch fetch PubChem CACTVS 881-bit substructure fingerprints by CID list.
 * Returns Map<cid_string, base64_fingerprint>.
 *
 * V0.3.5: CACTVS Substructure Keys are NIH PubChem's primary-computed
 * binary fingerprint — same authority class as XLogP/TPSA (deterministic
 * substructure detection from canonical structure). Enables structural
 * similarity search via Tanimoto coefficient without RDKit dependency.
 *
 * Format: base64-encoded ~156 chars per compound (881-bit fingerprint +
 * 4-byte header). Decode to bit array at query time for similarity ops.
 */
export async function fetchFingerprint2DBatch(cids, batchSize = 100) {
    if (!cids?.length) return new Map();
    const result = new Map();
    for (let i = 0; i < cids.length; i += batchSize) {
        const chunk = cids.slice(i, i + batchSize);
        const url = `${PUBCHEM_BASE}/compound/cid/${chunk.join(',')}/property/Fingerprint2D/JSON`;
        try {
            const data = await fetchJson(url);
            const props = data?.PropertyTable?.Properties ?? [];
            for (const p of props) {
                if (p.CID != null && p.Fingerprint2D) {
                    result.set(String(p.CID), p.Fingerprint2D);
                }
            }
        } catch (e) {
            console.warn(`[PUBCHEM] fingerprint batch ${i}-${i + chunk.length}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 250));
    }
    return result;
}

/**
 * Fetch + normalize a compound by CID.
 *
 * - Throws on transient fetch failure (HTTP 5xx, network error, timeout) so
 *   the caller can route the CID to the retry queue. Conflating "fetch
 *   failed" with "no data" silently advanced the cursor past failed CIDs;
 *   V0.5.1 separates the two so transient failures are recoverable across
 *   cron cycles via the persistent retry queue.
 * - Returns null when the CID is reachable but has no property record
 *   (deprecated / superseded CIDs that genuinely have no data to harvest).
 */
export async function getCompound(cid) {
    const [raw, synonyms] = await Promise.all([
        fetchCompound(cid),
        fetchSynonyms(cid),
    ]);
    if (!raw) return null;
    return normalize(raw, synonyms);
}
