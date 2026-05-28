/**
 * PubChem BioAssay Adapter — Sciweon V0.3.1
 *
 * Second bioactivity source (after ChEMBL). PubChem BioAssay aggregates
 * screening data from a different deposit pool than ChEMBL:
 *   - PubChem: NIH-funded MLP / NCI / academic deposits / industry submissions
 *   - ChEMBL: pharmaceutical literature curated by EMBL-EBI
 * Independent collections → genuine cross-source measurement consensus
 * (same compound + target measured by independent assay groups).
 *
 * API: https://pubchem.ncbi.nlm.nih.gov/rest/pug
 * Endpoint: /compound/cid/{CID}/assaysummary/JSON
 *
 * PRIMARY-DATA contract (primary-data-only policy):
 *   Consumed (raw assay metadata + experimenter-supplied labels):
 *     - AID (PubChem Assay ID)
 *     - SID (substance ID) / CID
 *     - Activity Outcome (assay depositor's classification — same level as
 *       a research paper author's reported result, not a PubChem second
 *       opinion. Equivalent in primacy to a publication's stated finding.)
 *     - Target Accession (UniProt) — cross-link to UniProt entries
 *     - Target GeneID (NCBI Gene)
 *     - Activity Value [uM]  (PubChem normalizes to uM — objective unit)
 *     - Activity Name (IC50/Ki/etc — assay measurement type)
 *     - Assay Name (raw assay description from depositor)
 *     - Assay Type
 *     - PubMed ID (cited paper, primary linkage)
 *
 *   Sciweon still computes is_active from value+threshold (per
 *   bioactivity-scorer.js) — Activity Outcome string is consumed only
 *   for cross-source agreement checks, never for decision logic.
 */

// V2 adapter contract: reactive AID/CID lookup — called per-compound from stage-2 enrichment.
export const supportsIncremental = false;

import { fetchJsonWithRetry } from '../../factory/lib/fetch-with-retry.js';

const PUBCHEM_BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_DELAY_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cycle 21 — replaced inline 5-sec/single-retry block with the shared
// helper (3 attempts + exponential backoff + 429/503 + Retry-After).
// Behavior strictly better; 404 still returned as null for callers that
// treat absent-bioassay as empty (existing semantics).
function fetchJson(url) {
    return fetchJsonWithRetry(url, { timeoutMs: REQUEST_TIMEOUT_MS, allow404: true });
}

// PR-CORE-PUBCHEM-BIOASSAY-DRAIN 2026-05-28 (architect lock): 503-storm
// circuit breaker. PubChem PUG REST goes 503 during NCBI maintenance
// windows; without short-circuit each CID burns ~5s on 3-retry exponential
// backoff before throwing -- thousands of CIDs cascade into multi-hour
// F2 black-hole (F2 run 26567469567 stuck 2.5h pre-cancel).
//
// Pattern: per-CID `fetchAssaySummaryByCid` checks the module-level
// breaker at entry. Tripped -> instant return [] without HTTP. Caller's
// drainAdapterBacklog iteration then sweeps remaining CIDs at near-zero
// latency, advances cursor normally, F2 stage exits gracefully.
//
// Reset semantics: F2 spawns each enricher in a fresh `node` process via
// runScript() -> module state does not leak across enrichers OR cron
// cycles. Each new F2 cycle gets a clean breaker; PubChem recovery
// surfaces immediately on next run.
const CIRCUIT_503_THRESHOLD = 3;
const breakerState = {
    consecutive503: 0,
    tripped: false,
    trippedAt: null,
    tripCount: 0,
};

export function getCircuitBreakerState() {
    return { ...breakerState };
}

export function resetCircuitBreaker() {
    breakerState.consecutive503 = 0;
    breakerState.tripped = false;
    breakerState.trippedAt = null;
    breakerState.tripCount = 0;
}

/**
 * Fetch all bioassay summary rows for one compound (CID).
 * Returns parsed array of assay records (PRIMARY-only fields).
 */
export async function fetchAssaySummaryByCid(cid) {
    if (!cid) return [];
    // PR-CORE-PUBCHEM-BIOASSAY-DRAIN circuit breaker: short-circuit on
    // 503-storm. caller treats [] as "no assay summary" (existing semantics).
    if (breakerState.tripped) return [];
    const url = `${PUBCHEM_BASE}/compound/cid/${cid}/assaysummary/JSON`;
    try {
        const data = await fetchJson(url);
        breakerState.consecutive503 = 0;  // reset on any success
        if (!data?.Table?.Row) return [];
        const cols = (data.Table.Columns?.Column ?? []).map(c => c);
        const idx = {
            aid: cols.indexOf('AID'),
            sid: cols.indexOf('SID'),
            cid: cols.indexOf('CID'),
            outcome: cols.indexOf('Activity Outcome'),
            target_accession: cols.indexOf('Target Accession'),
            target_gene_id: cols.indexOf('Target GeneID'),
            value_uM: cols.indexOf('Activity Value [uM]'),
            activity_name: cols.indexOf('Activity Name'),
            assay_name: cols.indexOf('Assay Name'),
            assay_type: cols.indexOf('Assay Type'),
            pubmed_id: cols.indexOf('PubMed ID'),
        };
        return data.Table.Row
            .map(r => parseAssayRow(r.Cell, idx))
            .filter(Boolean);
    } catch (e) {
        // Detect 503 (fetchJsonWithRetry exhausts its own 3 retries before
        // throwing -> one exception here == 3 PubChem requests already
        // failed for this CID). Each failing CID burns ~3-15s on retry
        // backoff. Tripping after 3 consecutive == ~9-45s tolerance,
        // then all remaining CIDs short-circuit in <1ms each.
        if (e?.message?.includes('HTTP 503')) {
            breakerState.consecutive503++;
            if (!breakerState.tripped && breakerState.consecutive503 >= CIRCUIT_503_THRESHOLD) {
                breakerState.tripped = true;
                breakerState.trippedAt = new Date().toISOString();
                breakerState.tripCount++;
                console.warn(`[PUBCHEM-BIOASSAY] 503-storm circuit-breaker TRIPPED after ${CIRCUIT_503_THRESHOLD} consecutive 503 exhaustions; remaining CIDs short-circuit to [] until process restart`);
            }
        }
        console.warn(`[PUBCHEM-BIOASSAY] CID ${cid}: ${e.message}`);
        return [];
    }
}

function parseAssayRow(cells, idx) {
    if (!Array.isArray(cells)) return null;
    const aid = cells[idx.aid];
    if (!aid) return null;
    const valueUm = cells[idx.value_uM];
    const value = valueUm && valueUm !== '' ? parseFloat(valueUm) : null;
    return {
        aid: String(aid),
        sid: cells[idx.sid] ? String(cells[idx.sid]) : null,
        cid: cells[idx.cid] ? String(cells[idx.cid]) : null,
        activity_outcome: cells[idx.outcome] || null,
        target_accession: cells[idx.target_accession] || null,
        target_gene_id: cells[idx.target_gene_id] ? String(cells[idx.target_gene_id]) : null,
        value_uM: typeof value === 'number' && Number.isFinite(value) ? value : null,
        activity_name: cells[idx.activity_name] || null,
        assay_name: cells[idx.assay_name] || null,
        assay_type: cells[idx.assay_type] || null,
        pubmed_id: cells[idx.pubmed_id] ? String(cells[idx.pubmed_id]) : null,
    };
}

// PubChem returns mixed accession types (RefSeq NP_*, GenBank, UniProt).
// For cross-validation against bioactivity.target.uniprot_accession we only
// index UniProt-format accessions (6-char SwissProt or 10-char TrEMBL).
const UNIPROT_RE = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

/**
 * Build a lookup index from a compound's assay rows for fast cross-validation:
 *   key = "{uniprot_accession}|{activity_type_normalized}"
 *   value = array of matching assay rows
 *
 * Rows whose Target Accession is not a UniProt-format string (e.g. RefSeq
 * NP_xxxxx or GenBank AAA29795) are skipped — those would need a separate
 * NCBI Protein → UniProt mapping step (V0.4 enhancement).
 */
export function buildAssayIndex(rows) {
    const index = new Map();
    for (const r of rows) {
        if (!r.target_accession) continue;
        if (!UNIPROT_RE.test(r.target_accession)) continue;
        const activityType = normalizeActivityName(r.activity_name);
        if (!activityType) continue;
        const key = `${r.target_accession}|${activityType}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(r);
    }
    return index;
}

const ACTIVITY_NAME_MAP = {
    'IC50': 'IC50', 'EC50': 'EC50', 'AC50': 'AC50', 'KI': 'Ki', 'KD': 'Kd',
    'IC90': 'IC90', 'GI50': 'GI50',
};

function normalizeActivityName(name) {
    if (!name) return null;
    return ACTIVITY_NAME_MAP[name.toUpperCase()] ?? null;
}

const UNIT_TO_UM = { nM: 0.001, uM: 1, mM: 1000, M: 1_000_000 };

/**
 * Compare a Sciweon bioactivity record (sourced from ChEMBL) against
 * PubChem assay rows for the same compound + target + activity type.
 *
 * Returns { has_pubchem_match, pubchem_aid_count, value_agreement, n_sources }.
 *
 * Agreement bands (after converting both values to uM):
 *   - agree: ratio < 10x  (within an order of magnitude)
 *   - soft_agree: ratio < 100x
 *   - conflict: ratio >= 100x
 */
export function crossValidateBioactivity(bioactivity, pubchemIndex) {
    const uniprot = bioactivity.target?.uniprot_accession;
    if (!uniprot) return { has_pubchem_match: false, pubchem_aid_count: 0, value_agreement: null, n_sources: 1 };

    const key = `${uniprot}|${bioactivity.activity_type}`;
    const matches = pubchemIndex.get(key) ?? [];
    if (matches.length === 0) return { has_pubchem_match: false, pubchem_aid_count: 0, value_agreement: null, n_sources: 1 };

    const valueUm = (bioactivity.value ?? null) * (UNIT_TO_UM[bioactivity.unit] ?? 0);
    if (!Number.isFinite(valueUm) || valueUm <= 0) {
        return { has_pubchem_match: true, pubchem_aid_count: matches.length, value_agreement: null, n_sources: 2 };
    }

    let bestRatio = Infinity;
    for (const m of matches) {
        if (m.value_uM == null || m.value_uM <= 0) continue;
        const ratio = Math.max(valueUm, m.value_uM) / Math.min(valueUm, m.value_uM);
        if (ratio < bestRatio) bestRatio = ratio;
    }
    let agreement = null;
    if (bestRatio < 10) agreement = 'agree';
    else if (bestRatio < 100) agreement = 'soft_agree';
    else if (Number.isFinite(bestRatio)) agreement = 'conflict';

    return {
        has_pubchem_match: true,
        pubchem_aid_count: matches.length,
        value_agreement: agreement,
        n_sources: 2,
    };
}

export { REQUEST_DELAY_MS };
