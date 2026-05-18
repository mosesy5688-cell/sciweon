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

function bootstrapSince() {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
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

export async function checkForUpdates(sinceToken) {
    const since = sinceToken ?? bootstrapSince();
    const url = `${CHEMBL_BASE}/molecule.json?molecule_date__gte=${since}&limit=1`;
    const data = await fetchJson(url);
    const count = data?.page_meta?.total_count ?? 0;
    return {
        hasUpdates: count > 0,
        count,
        nextSinceToken: new Date().toISOString().slice(0, 10),
    };
}

export async function fetchIncremental(sinceToken) {
    const since = sinceToken ?? bootstrapSince();
    const url = `${CHEMBL_BASE}/molecule.json?molecule_date__gte=${since}&limit=${INCREMENTAL_LIMIT}&order_by=molecule_date`;
    const data = await fetchJson(url);
    const molecules = data?.molecules ?? [];
    const records = molecules.map(normalizeMolecule).filter(Boolean);
    return {
        records,
        nextSinceToken: new Date().toISOString().slice(0, 10),
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
