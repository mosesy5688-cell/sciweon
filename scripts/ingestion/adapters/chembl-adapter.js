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

/**
 * Map ChEMBL activity_comment / standard_value to is_active boolean.
 * "Active" / "active" / "Not Active" / "inactive" / "Inconclusive"
 */
function deriveIsActive(activity) {
    const comment = (activity.activity_comment ?? '').toLowerCase();
    if (comment.includes('not active') || comment.includes('inactive') || comment.includes('no effect')) return false;
    if (comment.includes('active')) return true;
    return null;
}

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
 */
export function normalizeActivity(raw, compoundId) {
    if (!raw || !raw.activity_id) return null;
    const value = raw.standard_value != null ? parseFloat(raw.standard_value) : null;
    if (value == null || !Number.isFinite(value) || value < 0) return null;

    const timestamp = new Date().toISOString();
    const unitInfo = normalizeUnit(raw.standard_units);
    return {
        id: `sciweon::bioactivity::CHEMBL_ACT_${raw.activity_id}`,
        compound_id: compoundId,
        target_id: raw.target_chembl_id ?? 'unknown',
        activity_type: normalizeActivityType(raw.standard_type),
        value,
        unit: unitInfo.unit,
        unit_raw: unitInfo.unit_raw,
        is_active: deriveIsActive(raw),
        activity_comment: raw.activity_comment ?? null,
        confidence_score: raw.confidence_score ?? null,
        assay_description: raw.assay_description ?? null,
        assay_type: ASSAY_TYPE_MAP[raw.assay_type] ?? null,
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
