/**
 * UniChem Adapter — Sciweon V0.3.2
 *
 * EMBL-EBI's structure-based cross-reference service. One InChIKey lookup
 * returns canonical IDs across all major chemical databases — eliminates
 * the need for per-database name matching (fragile) or DOI walking.
 *
 * API docs: https://www.ebi.ac.uk/unichem/info/widesearchInfo
 * Base: https://www.ebi.ac.uk/unichem/rest
 *
 * PRIMARY-DATA contract:
 *   Consumed (international standard identifiers, authoritative-source exempt):
 *     - src_14: FDA UNII  (US FDA canonical substance identifier)
 *     - src_2:  DrugBank ID
 *     - src_7:  ChEBI ID  (EBI international chemistry ontology)
 *     - src_22: PubChem CID  (already have, used for sanity)
 *     - src_1:  ChEMBL ID  (already have)
 *     - src_27: KEGG_DRUG  (international drug nomenclature)
 *     - src_41: HMDB
 *     - src_46: ClinicalTrials.gov
 *
 *   UniChem itself does not classify or score — it transmits identifiers
 *   from the source databases keyed by structural identity (InChIKey).
 *   This is identifier mapping, not derived classification.
 */

// V2 adapter contract: reactive lookup only — no source-side incremental API.
export const supportsIncremental = false;

const UNICHEM_BASE = 'https://www.ebi.ac.uk/unichem/rest';
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_DELAY_MS = 200;

// UniChem src_id -> Sciweon field name. Only consume IDs from authoritative
// international standard bodies (FDA / EBI / NLM / etc.).
const SOURCE_FIELD_MAP = {
    1: 'chembl_id',           // ChEMBL (EBI)
    2: 'drugbank_id',         // DrugBank (open subset)
    7: 'chebi_id',            // ChEBI (EBI)
    14: 'unii',               // FDA UNII
    22: 'pubchem_cid',        // PubChem
    27: 'kegg_drug_id',       // KEGG_DRUG
    41: 'hmdb_id',            // HMDB
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
        if (res.status === 404) return null;
        if (res.status === 429 || res.status === 503) {
            await sleep(5000);
            const retry = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!retry.ok) throw new Error(`HTTP ${retry.status}: ${url}`);
            return retry.json();
        }
        throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return res.json();
}

/**
 * Lookup all chemical-database cross-references for a single InChIKey.
 * Returns Sciweon-shaped object with consumed source IDs only.
 *
 *   { unii, drugbank_id, chebi_id, kegg_drug_id, hmdb_id, ... }
 *
 * UniChem may return multiple entries per source (e.g. parent vs salt forms);
 * we keep the first encountered (UniChem orders by source preference).
 */
export async function fetchByInchiKey(inchiKey) {
    if (!inchiKey) return null;
    try {
        const data = await fetchJson(`${UNICHEM_BASE}/inchikey/${encodeURIComponent(inchiKey)}`);
        if (!Array.isArray(data)) return null;
        const result = {};
        for (const entry of data) {
            const srcId = parseInt(entry.src_id, 10);
            const field = SOURCE_FIELD_MAP[srcId];
            if (!field) continue;
            if (!result[field] && entry.src_compound_id) {
                result[field] = String(entry.src_compound_id);
            }
        }
        return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
        console.warn(`[UNICHEM] ${inchiKey}: ${e.message}`);
        return null;
    }
}

export { REQUEST_DELAY_MS };
