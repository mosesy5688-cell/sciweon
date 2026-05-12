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
const PROPERTIES = [
    'MolecularFormula', 'MolecularWeight', 'IUPACName', 'InChI', 'InChIKey',
    'CanonicalSMILES', 'IsomericSMILES', 'XLogP', 'ExactMass', 'TPSA',
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
        smiles_canonical: raw.CanonicalSMILES ?? raw.IsomericSMILES ?? '',
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
 * Fetch + normalize a compound by CID. Returns null if invalid.
 */
export async function getCompound(cid) {
    const [raw, synonyms] = await Promise.all([
        fetchCompound(cid).catch(e => { console.warn(`[PUBCHEM] CID ${cid}: ${e.message}`); return null; }),
        fetchSynonyms(cid),
    ]);
    if (!raw) return null;
    return normalize(raw, synonyms);
}
