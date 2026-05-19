/**
 * ChEMBL Adapter V2 — Sciweon DataSourceAdapterV2 interface (§11.2).
 *
 * sinceToken: YYYY-MM-DD date string (molecule_date filter). null = today − 7 days.
 * Incremental fetches newly registered or updated molecules (max_phase, withdrawn,
 * atc_codes, approval_year) and returns compound drug_status enrichment records.
 *
 * V1 functions (findByInchiKey, fetchActivities, normalizeActivity, etc.) are
 * kept for the existing stage-2 enrichment pipeline.
 *
 * Rate limit: ~5 req/sec, public free.
 * API docs: https://www.ebi.ac.uk/chembl/api/data/docs
 */

import { deriveIsActive, scoreBioactivityConfidence } from '../../factory/lib/bioactivity-scorer.js';
import { normalizeUnit, normalizeActivityType, ASSAY_TYPE_MAP } from './chembl-helpers.js';
import {
    resolveSinceYear,
} from '../../factory/lib/chembl-since-token.js';
import {
    shouldFetchNextPage, nextSinceTokenAfterLoop,
} from '../../factory/lib/pagination-control.js';

const CHEMBL_BASE = 'https://www.ebi.ac.uk/chembl/api/data';
const REQUEST_TIMEOUT_MS = 20000;
const INCREMENTAL_LIMIT  = 200;

// ─── V2 adapter contract ──────────────────────────────────────────────────
export const supportsIncremental     = true;
export const fallbackFullRefreshDays = 30;

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

function normalizeMolecule(mol) {
    if (!mol?.molecule_chembl_id) return null;
    const rawPhase = mol.max_phase;
    const maxPhase = rawPhase == null ? null : parseFloat(rawPhase);
    const ts = new Date().toISOString();
    return {
        id: `sciweon::compound::chembl::${mol.molecule_chembl_id}`,
        chembl_id: mol.molecule_chembl_id,
        inchi_key: mol.molecule_structures?.standard_inchi_key ?? null,
        drug_status: {
            max_phase: maxPhase != null && Number.isFinite(maxPhase) ? maxPhase : null,
            first_approval_year: mol.first_approval ?? null,
            withdrawn: mol.withdrawn_flag === true,
            withdrawn_reason: mol.withdrawn_reason ?? null,
            black_box_warning: mol.black_box_warning === 1 || mol.black_box_warning === true,
            atc_codes: (mol.atc_classifications ?? []).map(a => typeof a === 'string' ? a : a.level5).filter(Boolean),
        },
        provenance: {
            sources: [{ source: 'chembl', source_id: mol.molecule_chembl_id, timestamp: ts, extraction_method: 'chembl_rest_v2' }],
            last_updated: ts,
        },
        confidence: { overall: 75, method: 'cross_source_consensus_v1' },
    };
}

async function countByFilter(filter) {
    try {
        const data = await fetchJson(`${CHEMBL_BASE}/molecule.json?${filter}&limit=1`);
        return data?.page_meta?.total_count ?? 0;
    } catch (e) {
        console.warn(`[CHEMBL] countByFilter ${filter}: ${e.message}`);
        return 0;
    }
}

export async function checkForUpdates(sinceToken) {
    const year = resolveSinceYear(sinceToken);
    const thisYearStr = String(new Date().getUTCFullYear());
    const [approvalsCount, withdrawalsCount] = await Promise.all([
        countByFilter(`first_approval__gte=${year}`),
        countByFilter(`withdrawn_year__gte=${year}`),
    ]);
    const count = approvalsCount + withdrawalsCount;
    return { hasUpdates: count > 0, count, nextSinceToken: thisYearStr };
}

async function fetchMoleculePages(filter) {
    const records = [];
    let offset = 0;
    let pagesDone = 0;
    let stopKind = 'stop_exhausted';
    while (true) {
        const url = `${CHEMBL_BASE}/molecule.json?${filter}&limit=${INCREMENTAL_LIMIT}&offset=${offset}`;
        let data;
        try { data = await fetchJson(url); }
        catch (e) {
            console.warn(`[CHEMBL] fetchMoleculePages ${filter} page ${pagesDone + 1}: ${e.message}`);
            break;
        }
        const mols = data?.molecules ?? [];
        for (const m of mols) {
            const norm = normalizeMolecule(m);
            if (norm) records.push(norm);
        }
        pagesDone++;
        offset += INCREMENTAL_LIMIT;
        const total = data?.page_meta?.total_count ?? records.length;
        const decision = shouldFetchNextPage({
            recordsFetched: records.length,
            pagesDone,
            hasMoreSignal: offset < total && mols.length > 0,
        });
        if (decision.kind !== 'continue') { stopKind = decision.kind; break; }
    }
    if (stopKind !== 'stop_exhausted') {
        console.warn(`[CHEMBL] fetchMoleculePages ${filter} ${stopKind} after ${pagesDone} pages / ${records.length} records`);
    }
    return { records, stopKind };
}

export async function fetchIncremental(sinceToken) {
    const year = resolveSinceYear(sinceToken);
    const today = String(new Date().getUTCFullYear());
    const filters = [
        `first_approval__gte=${year}`,
        `withdrawn_year__gte=${year}`,
    ];
    const seen = new Map();
    let aggregateStopKind = 'stop_exhausted';
    for (const filter of filters) {
        const { records: pageRecords, stopKind } = await fetchMoleculePages(filter);
        for (const r of pageRecords) {
            if (r?.chembl_id && !seen.has(r.chembl_id)) seen.set(r.chembl_id, r);
        }
        if (stopKind !== 'stop_exhausted') aggregateStopKind = stopKind;
    }
    return {
        records: [...seen.values()],
        nextSinceToken: nextSinceTokenAfterLoop({
            stopKind: aggregateStopKind, sinceToken: String(year), today,
        }),
    };
}

// ─── V1 functions (stage-2 enrichment pipeline) ───────────────────────────

export async function findByInchiKey(inchiKey) {
    try {
        const url = `${CHEMBL_BASE}/molecule.json?molecule_structures__standard_inchi_key=${encodeURIComponent(inchiKey)}&limit=1`;
        const data = await fetchJson(url);
        return data?.molecules?.[0] ?? null;
    } catch (e) { console.warn(`[CHEMBL] InChIKey ${inchiKey}: ${e.message}`); return null; }
}

export async function fetchTargetByChemblId(chemblTargetId) {
    try {
        return await fetchJson(`${CHEMBL_BASE}/target/${chemblTargetId}.json`);
    } catch (e) { console.warn(`[CHEMBL] target ${chemblTargetId}: ${e.message}`); return null; }
}

export function extractTargetPrimary(raw) {
    if (!raw || !raw.target_chembl_id) return null;
    const accessions = (raw.target_components ?? []).map(c => c.accession).filter(Boolean);
    return {
        chembl_id: raw.target_chembl_id,
        chembl_pref_name: raw.pref_name ?? null,
        target_type: raw.target_type ?? null,
        chembl_organism: raw.organism ?? null,
        chembl_tax_id: typeof raw.tax_id === 'number' ? raw.tax_id : null,
        uniprot_accessions: accessions,
    };
}

export async function fetchActivities(chemblId, maxRecords = 100) {
    try {
        const data = await fetchJson(`${CHEMBL_BASE}/activity.json?molecule_chembl_id=${chemblId}&limit=${maxRecords}`);
        return data?.activities ?? [];
    } catch (e) { console.warn(`[CHEMBL] activities ${chemblId}: ${e.message}`); return []; }
}

export function normalizeDrugStatus(molecule) {
    if (!molecule) return null;
    const rawPhase = molecule.max_phase;
    const maxPhase = rawPhase == null ? null : parseFloat(rawPhase);
    return {
        max_phase: maxPhase != null && Number.isFinite(maxPhase) ? maxPhase : null,
        first_approval_year: molecule.first_approval ?? null,
        withdrawn: molecule.withdrawn_flag === true,
        withdrawn_reason: molecule.withdrawn_reason ?? null,
        black_box_warning: molecule.black_box_warning === 1 || molecule.black_box_warning === true,
        atc_codes: (molecule.atc_classifications ?? []).map(a => typeof a === 'string' ? a : a.level5).filter(Boolean),
    };
}

export function normalizeActivity(raw, compoundId) {
    if (!raw || !raw.activity_id) return null;
    const value = raw.standard_value != null ? parseFloat(raw.standard_value) : null;
    if (value == null || !Number.isFinite(value) || value < 0) return null;
    const ts = new Date().toISOString();
    const unitInfo = normalizeUnit(raw.standard_units);
    const activityType = normalizeActivityType(raw.standard_type);
    const assayType = ASSAY_TYPE_MAP[raw.assay_type] ?? null;
    const measurement = { value, unit: unitInfo.unit, activity_type: activityType };
    const isActiveResult = deriveIsActive(measurement);
    const sciweonConfidence = scoreBioactivityConfidence({ ...measurement, assay_type: assayType });
    return {
        id: `sciweon::bioactivity::CHEMBL_ACT_${raw.activity_id}`,
        compound_id: compoundId,
        target_id: raw.target_chembl_id ?? 'unknown',
        activity_type: activityType,
        value, unit: unitInfo.unit, unit_raw: unitInfo.unit_raw,
        is_active: isActiveResult.is_active, is_active_method: isActiveResult.method,
        sciweon_confidence: sciweonConfidence,
        activity_comment: raw.activity_comment ?? null,
        assay_description: raw.assay_description ?? null,
        assay_type: assayType,
        organism: raw.target_organism ?? null,
        provenance: {
            sources: [{ source: 'chembl', source_id: String(raw.activity_id), timestamp: ts, extraction_method: 'chembl_rest_v1' }],
            last_updated: ts,
        },
    };
}
