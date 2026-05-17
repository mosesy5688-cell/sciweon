/**
 * ChEMBL Adapter — Sciweon V0.1
 *
 * Fetches compound + bioactivity data from ChEMBL REST API.
 *
 * Endpoints:
 *   /molecule/{chembl_id}     — compound metadata + drug status
 *   /molecule?molecule_structures__standard_inchi_key={key}  — InChIKey lookup (cross-source)
 *   /activity?molecule_chembl_id={id}  — bioactivity records
 *
 * API docs: https://www.ebi.ac.uk/chembl/api/data/docs
 * Rate limit: ~5 req/sec, public free.
 */

import { deriveIsActive, scoreBioactivityConfidence } from '../../factory/lib/bioactivity-scorer.js';

const CHEMBL_BASE = 'https://www.ebi.ac.uk/chembl/api/data';
const REQUEST_TIMEOUT_MS = 20000;

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

/**
 * Find ChEMBL molecule by InChIKey (cross-source linking key).
 * Returns: { molecule_chembl_id, inchi_key, max_phase, withdrawn, ... } or null.
 */
export async function findByInchiKey(inchiKey) {
    try {
        const url = `${CHEMBL_BASE}/molecule.json?molecule_structures__standard_inchi_key=${encodeURIComponent(inchiKey)}&limit=1`;
        const data = await fetchJson(url);
        return data?.molecules?.[0] ?? null;
    } catch (e) {
        console.warn(`[CHEMBL] InChIKey ${inchiKey}: ${e.message}`);
        return null;
    }
}

/**
 * Fetch a ChEMBL target record by target_chembl_id.
 * Returns the raw target object including target_components[].accession
 * (UniProt cross-reference). Returns null on 404 / error.
 */
export async function fetchTargetByChemblId(chemblTargetId) {
    try {
        const url = `${CHEMBL_BASE}/target/${chemblTargetId}.json`;
        const data = await fetchJson(url);
        return data ?? null;
    } catch (e) {
        console.warn(`[CHEMBL] target ${chemblTargetId}: ${e.message}`);
        return null;
    }
}

/**
 * Extract PRIMARY-ONLY target metadata from a raw ChEMBL target record.
 * Provides the ChEMBL-side view; UniProt provides the second source.
 */
export function extractTargetPrimary(raw) {
    if (!raw || !raw.target_chembl_id) return null;
    const accessions = (raw.target_components ?? [])
        .map(c => c.accession)
        .filter(Boolean);
    return {
        chembl_id: raw.target_chembl_id,
        chembl_pref_name: raw.pref_name ?? null,
        target_type: raw.target_type ?? null,
        chembl_organism: raw.organism ?? null,
        chembl_tax_id: typeof raw.tax_id === 'number' ? raw.tax_id : null,
        uniprot_accessions: accessions,
    };
}

/**
 * Fetch all activities for a molecule (paginated).
 * Returns array of raw activity records.
 */
export async function fetchActivities(chemblId, maxRecords = 100) {
    try {
        const url = `${CHEMBL_BASE}/activity.json?molecule_chembl_id=${chemblId}&limit=${maxRecords}`;
        const data = await fetchJson(url);
        return data?.activities ?? [];
    } catch (e) {
        console.warn(`[CHEMBL] activities ${chemblId}: ${e.message}`);
        return [];
    }
}

/**
 * Normalize ChEMBL molecule → drug_status fragment for Compound entity.
 */
export function normalizeDrugStatus(molecule) {
    if (!molecule) return null;
    // ChEMBL max_phase comes as string "1.0" / "0.5" / etc. Parse to number.
    const rawPhase = molecule.max_phase;
    const maxPhase = rawPhase == null ? null : parseFloat(rawPhase);
    return {
        max_phase: (maxPhase != null && Number.isFinite(maxPhase)) ? maxPhase : null,
        first_approval_year: molecule.first_approval ?? null,
        withdrawn: molecule.withdrawn_flag === true,
        withdrawn_reason: molecule.withdrawn_reason ?? null,
        black_box_warning: molecule.black_box_warning === 1 || molecule.black_box_warning === true,
        atc_codes: (molecule.atc_classifications ?? []).map(a => typeof a === 'string' ? a : a.level5).filter(Boolean),
    };
}

// is_active and Sciweon confidence are computed by ./bioactivity-scorer.js
// from PRIMARY measurement data (value + unit + activity_type), NOT from
// ChEMBL's `activity_comment` text or `confidence_score`. Both ChEMBL fields
// are curator secondary annotations and are excluded per the primary-data
// principle (primary-data-only policy).

const UNIT_MAP = {
    // Molar concentration
    'nM': 'nM', 'uM': 'uM', 'μM': 'uM', 'mM': 'mM', 'M': 'M',
    // Percent
    '%': 'percent', 'percent': 'percent',
    // Mass concentration → 'other' (real but non-standard for our enum)
    'mg/kg': 'other', 'g/kg': 'other', 'ug/kg': 'other',
    'mg/mL': 'other', 'ug/mL': 'other', 'ng/mL': 'other',
    'mol/L': 'other', 'mmol/L': 'other', 'umol/L': 'other',
    'mg.kg-1': 'other', 'mg/L': 'other',
    // Time
    'min': 'other', 'hr': 'other', 'hour': 'other', 'sec': 'other', 'd': 'other',
    // Inverse
    '/L': 'other', '/mL': 'other',
    // Ratios / dimensionless
    'ratio': 'unitless', 'pKa': 'unitless', 'pKi': 'unitless', 'pIC50': 'unitless',
    // Empty / null
    '': 'unitless', 'unitless': 'unitless',
};

function normalizeUnit(raw) {
    if (!raw) return { unit: 'unitless', unit_raw: null };
    const trimmed = raw.trim();
    const mapped = UNIT_MAP[trimmed];
    if (mapped) return { unit: mapped, unit_raw: trimmed };
    // Unknown unit string — preserve raw, classify as 'other'
    return { unit: 'other', unit_raw: trimmed };
}

const ACTIVITY_TYPE_MAP = {
    IC50: 'IC50', Ki: 'Ki', EC50: 'EC50', Kd: 'Kd', AC50: 'AC50',
    IC90: 'IC90', GI50: 'GI50',
};

function normalizeActivityType(raw) {
    if (!raw) return 'other';
    return ACTIVITY_TYPE_MAP[raw.toUpperCase()] ?? (
        raw.toLowerCase().includes('inhibition') ? 'inhibition' : 'other'
    );
}

const ASSAY_TYPE_MAP = {
    B: 'binding', F: 'functional', A: 'admet', T: 'toxicity', P: 'other', U: 'other',
};

/**
 * Normalize raw ChEMBL activity → Sciweon Bioactivity schema.
 *
 * Primary fields (transparently passed through): activity_id, target,
 * activity_type, value, unit, assay_description, organism.
 *
 * Derived by Sciweon (NOT consumed from ChEMBL secondary fields):
 *   is_active           — bioactivity-scorer.deriveIsActive()
 *   is_active_method    — provenance for the derivation
 *   sciweon_confidence  — bioactivity-scorer.scoreBioactivityConfidence()
 *
 * Raw text preserved for V0.4 NLP (not consumed for decisions):
 *   activity_comment    — ChEMBL curator's textual annotation (reference only)
 */
export function normalizeActivity(raw, compoundId) {
    if (!raw || !raw.activity_id) return null;
    const value = raw.standard_value != null ? parseFloat(raw.standard_value) : null;
    if (value == null || !Number.isFinite(value) || value < 0) return null;

    const timestamp = new Date().toISOString();
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
        value,
        unit: unitInfo.unit,
        unit_raw: unitInfo.unit_raw,
        is_active: isActiveResult.is_active,
        is_active_method: isActiveResult.method,
        sciweon_confidence: sciweonConfidence,
        // Raw ChEMBL curator commentary preserved as text for V0.4 NLP
        // (not consumed for any decision logic here).
        activity_comment: raw.activity_comment ?? null,
        assay_description: raw.assay_description ?? null,
        assay_type: assayType,
        organism: raw.target_organism ?? null,
        provenance: {
            sources: [{
                source: 'chembl',
                source_id: String(raw.activity_id),
                timestamp,
                extraction_method: 'chembl_rest_v1',
            }],
            last_updated: timestamp,
        },
    };
}
