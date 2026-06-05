/**
 * PubChem Adapter V2 — Sciweon DataSourceAdapterV2 interface (§11.2).
 *
 * sinceToken: last processed CID (string integer). null = bootstrap from 0.
 * Incremental batch = 200 CIDs/run (new CIDs only; bulk backfill is a separate
 * pipeline). Rate limit: 5 req/sec anonymous; batch fetch = 100 CIDs/request.
 */

import { computeLipinskiViolations } from '../../factory/lib/lipinski.js';
import { scoreEntity } from '../../factory/lib/confidence-scorer.js';
import { fetchJsonWithRetry } from '../../factory/lib/fetch-with-retry.js';

// ─── V2 adapter contract ──────────────────────────────────────────────────
export const supportsIncremental     = true;
export const fallbackFullRefreshDays = 7;

const BATCH_SIZE       = 200; // CIDs per daily incremental run
const PROP_CHUNK_SIZE  = 100; // CIDs per PubChem batch-property call

const PUBCHEM_BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const REQUEST_TIMEOUT_MS = 15000;
// PubChem deprecated CanonicalSMILES → SMILES (2025+). Request both for compatibility.
const PROPERTIES = [
    'MolecularFormula', 'MolecularWeight', 'IUPACName', 'InChI', 'InChIKey',
    'SMILES', 'CanonicalSMILES', 'IsomericSMILES', 'XLogP', 'ExactMass', 'TPSA',
    'Complexity', 'HBondDonorCount', 'HBondAcceptorCount', 'RotatableBondCount',
].join(',');

/**
 * Fetch raw PubChem data for a single CID. Cycle 21 fix: in-run retry +
 * 429/503 backoff via shared helper. Pre-fix, a single PubChem flake
 * would mark the CID as fetch_failed and overflow the cross-run retry
 * queue (F1 run 26269624764 halted with 2113 failures from one episode).
 */
export async function fetchCompound(cid) {
    const url = `${PUBCHEM_BASE}/compound/cid/${cid}/property/${PROPERTIES}/JSON`;
    const data = await fetchJsonWithRetry(url, { timeoutMs: REQUEST_TIMEOUT_MS });
    return data?.PropertyTable?.Properties?.[0] ?? null;
}

/**
 * Fetch synonyms for a CID (separate endpoint). 404 is normal for
 * compounds without synonym records — allow404 skips retry and returns
 * null, which the catch maps to [].
 */
export async function fetchSynonyms(cid) {
    try {
        const url = `${PUBCHEM_BASE}/compound/cid/${cid}/synonyms/JSON`;
        const data = await fetchJsonWithRetry(url, { timeoutMs: REQUEST_TIMEOUT_MS, allow404: true });
        return data?.InformationList?.Information?.[0]?.Synonym?.slice(0, 100) ?? [];
    } catch { return []; }
}

/**
 * PR-MD-2b.1: resolve a CID directly from an InChIKey (PubChem PUG REST). Used to
 * recover the corpus add-list `no_cid` bucket -- UniChem's InChIKey->PubChem xref is
 * a SUBSET of PubChem's own, so a direct query recovers small molecules UniChem missed.
 * 404 = PubChem has no record for this exact structure -> null (genuinely CID-unaddressable).
 *
 * FIDELITY LOCK: uses the FULL 27-char InChIKey ONLY -- NEVER the skeleton/connectivity
 * first-14 block. The first block matches the PARENT, but a UNII's specific substance
 * (salt/hydrate) differs from its parent (a different UNII), so a skeleton match would
 * inject the wrong substance and break the caller's UNII fidelity. Returns the first CID
 * (a full InChIKey usually maps 1; PubChem returns CID-ascending, [0] ~canonical).
 */
export async function fetchCidByInchiKey(inchiKey) {
    if (!inchiKey) return null;
    try {
        const url = `${PUBCHEM_BASE}/compound/inchikey/${encodeURIComponent(inchiKey)}/cids/JSON`;
        const data = await fetchJsonWithRetry(url, { timeoutMs: REQUEST_TIMEOUT_MS, allow404: true });
        const cid = data?.IdentifierList?.CID?.[0];
        return cid != null ? String(cid) : null;
    } catch { return null; }
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
 * Returns Map<cid_string, base64_fingerprint>. CACTVS Substructure Keys are
 * NIH PubChem primary-computed data (same authority class as XLogP/TPSA),
 * enabling Tanimoto similarity search without an RDKit dependency. Format:
 * base64 ~156 chars (881-bit fingerprint + 4-byte header), decoded at query.
 */
export async function fetchFingerprint2DBatch(cids, batchSize = 100) {
    if (!cids?.length) return new Map();
    const result = new Map();
    for (let i = 0; i < cids.length; i += batchSize) {
        const chunk = cids.slice(i, i + batchSize);
        const url = `${PUBCHEM_BASE}/compound/cid/${chunk.join(',')}/property/Fingerprint2D/JSON`;
        try {
            // allow404 -> a chunk whose CIDs genuinely lack CACTVS keys returns
            // null (nothing stamped), NOT an exception. A real 5xx is caught
            // below so one bad chunk cannot abort the others.
            const data = await fetchJsonWithRetry(url, { timeoutMs: REQUEST_TIMEOUT_MS, allow404: true });
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
 * - Throws on transient fetch failure (5xx / network / timeout) so the caller
 *   routes the CID to the retry queue (V0.5.1: do NOT conflate fetch-failed
 *   with no-data, which silently advanced the cursor past failed CIDs).
 * - Returns null when the CID is reachable but genuinely has no record
 *   (deprecated / superseded CIDs).
 */
export async function getCompound(cid) {
    const [raw, synonyms] = await Promise.all([
        fetchCompound(cid),
        fetchSynonyms(cid),
    ]);
    if (!raw) return null;
    return normalize(raw, synonyms);
}

// ─── V2 adapter functions ─────────────────────────────────────────────────

async function fetchPubchemCount() {
    // No allow404 -- the count endpoint must exist; a 404 here is a real fault.
    const url = `${PUBCHEM_BASE}/compound/count/JSON`;
    const data = await fetchJsonWithRetry(url, { timeoutMs: REQUEST_TIMEOUT_MS });
    return data?.PC_Count?.TotalCount ?? 0;
}

export async function batchFetchProperties(cids) {
    // POST body carries the CID list. Routed through fetchJsonWithRetry so the
    // batch POST gains in-run 429/503 retry + a clean 4xx throw (was a raw fetch).
    const url = `${PUBCHEM_BASE}/compound/cid/property/${PROPERTIES}/JSON`;
    const data = await fetchJsonWithRetry(url, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        requestInit: {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `cid=${cids.join(',')}`,
        },
    });
    return data?.PropertyTable?.Properties ?? [];
}

export async function batchFetchSynonyms(cids) {
    // POST body carries the CIDs (mirrors batchFetchProperties) -> no 100-CID
    // GET URL-length risk. allow404 -> null -> empty Map (parity with single-CID
    // fetchSynonyms 404 -> []). A real non-404 5xx exhaustion THROWS out of
    // fetchJsonWithRetry: VISIBLE, never masked as a silently-empty Map.
    const url = `${PUBCHEM_BASE}/compound/cid/synonyms/JSON`;
    const data = await fetchJsonWithRetry(url, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        allow404: true,
        requestInit: {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `cid=${cids.join(',')}`,
        },
    });
    const info = data?.InformationList?.Information ?? [];
    return new Map(info.map(it => [String(it.CID), it.Synonym?.slice(0, 100) ?? []]));
}

export async function checkForUpdates(sinceToken) {
    const lastCid  = sinceToken ? parseInt(sinceToken, 10) : 0;
    const total    = await fetchPubchemCount();
    return {
        hasUpdates: total > lastCid,
        count: Math.max(0, total - lastCid),
        nextSinceToken: String(total),
    };
}

export async function fetchIncremental(sinceToken) {
    const lastCid  = sinceToken ? parseInt(sinceToken, 10) : 0;
    const cidRange = Array.from({ length: BATCH_SIZE }, (_, i) => lastCid + 1 + i);
    const records  = [];
    for (let i = 0; i < cidRange.length; i += PROP_CHUNK_SIZE) {
        const chunk = cidRange.slice(i, i + PROP_CHUNK_SIZE);
        const [props, synMap] = await Promise.all([batchFetchProperties(chunk), batchFetchSynonyms(chunk)]);
        for (const raw of props) {
            // synMap is keyed by String(CID); raw.CID is numeric -> stringify.
            const entity = normalize(raw, synMap.get(String(raw.CID)) ?? []);
            if (entity) records.push(entity);
        }
        if (i + PROP_CHUNK_SIZE < cidRange.length) await new Promise(r => setTimeout(r, 200));
    }
    return { records, nextSinceToken: String(lastCid + BATCH_SIZE) };
}
