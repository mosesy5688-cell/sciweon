/**
 * ChEMBL unit/activity-type normalization helpers.
 * Extracted from chembl-adapter.js to keep that file under CES 250-line limit.
 */

export const UNIT_MAP = {
    'nM': 'nM', 'uM': 'uM', 'μM': 'uM', 'mM': 'mM', 'M': 'M',
    '%': 'percent', 'percent': 'percent',
    'mg/kg': 'other', 'g/kg': 'other', 'ug/kg': 'other',
    'mg/mL': 'other', 'ug/mL': 'other', 'ng/mL': 'other',
    'mol/L': 'other', 'mmol/L': 'other', 'umol/L': 'other',
    'mg.kg-1': 'other', 'mg/L': 'other',
    'min': 'other', 'hr': 'other', 'hour': 'other', 'sec': 'other', 'd': 'other',
    '/L': 'other', '/mL': 'other',
    'ratio': 'unitless', 'pKa': 'unitless', 'pKi': 'unitless', 'pIC50': 'unitless',
    '': 'unitless', 'unitless': 'unitless',
};

export function normalizeUnit(raw) {
    if (!raw) return { unit: 'unitless', unit_raw: null };
    const trimmed = raw.trim();
    const mapped = UNIT_MAP[trimmed];
    if (mapped) return { unit: mapped, unit_raw: trimmed };
    return { unit: 'other', unit_raw: trimmed };
}

const ACTIVITY_TYPE_MAP = {
    IC50: 'IC50', Ki: 'Ki', EC50: 'EC50', Kd: 'Kd', AC50: 'AC50',
    IC90: 'IC90', GI50: 'GI50',
};

export function normalizeActivityType(raw) {
    if (!raw) return 'other';
    return ACTIVITY_TYPE_MAP[raw.toUpperCase()] ?? (
        raw.toLowerCase().includes('inhibition') ? 'inhibition' : 'other'
    );
}

export const ASSAY_TYPE_MAP = {
    B: 'binding', F: 'functional', A: 'admet', T: 'toxicity', P: 'other', U: 'other',
};
