/**
 * CTIS Adapter Helpers — phase + status normalization extracted for CES compliance.
 */

export const PHASE_NORMALIZE = {
    'Phase 1': 1, 'Phase I': 1,
    'Phase 2': 2, 'Phase II': 2,
    'Phase 3': 3, 'Phase III': 3,
    'Phase 4': 4, 'Phase IV': 4,
};

export function normalizePhase(rawPhase) {
    if (rawPhase == null) return null;
    const s = String(rawPhase);
    for (const [k, v] of Object.entries(PHASE_NORMALIZE)) {
        if (s.includes(k)) return v;
    }
    return null;
}

export const TERMINATED_STATUSES = new Set([
    'ENDED_PREMATURELY', 'TERMINATED', 'HALTED', 'CANCELLED', 'WITHDRAWN',
]);

// CTIS /search returns ctStatus as numeric lifecycle code; /retrieve returns string.
// Codes verified empirically against representative trials.
export const SEARCH_STATUS_CODE_MAP = {
    2: 'AUTHORISED',
    3: 'AUTHORISED',
    4: 'AUTHORISED',
    5: 'AUTHORISED',
    6: 'HALTED',
    8: 'ENDED',
    11: 'NOT_YET_AUTHORISED',
};

export const RETRIEVE_STATUS_STRING_MAP = {
    'Authorised': 'AUTHORISED',
    'Under evaluation': 'UNDER_EVALUATION',
    'Ongoing': 'ONGOING',
    'Ended': 'ENDED',
    'Ended prematurely': 'ENDED_PREMATURELY',
    'Halted': 'HALTED',
    'Cancelled': 'CANCELLED',
    'Not authorised': 'NOT_YET_AUTHORISED',
};

export function normalizeStatus(rawStatus) {
    if (typeof rawStatus === 'number') return SEARCH_STATUS_CODE_MAP[rawStatus] ?? 'UNKNOWN';
    if (typeof rawStatus === 'string') return RETRIEVE_STATUS_STRING_MAP[rawStatus] ?? 'UNKNOWN';
    return 'UNKNOWN';
}
