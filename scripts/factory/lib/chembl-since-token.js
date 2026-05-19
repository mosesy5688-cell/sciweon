/**
 * V0.5.7 — ChEMBL adapter sinceToken parser.
 *
 * ChEMBL Molecule resource has no per-record updated_date filter (the legacy
 * `molecule_date__gte` field returns HTTP 400). Sciweon tracks chembl-side
 * changes at year granularity via `first_approval` and `withdrawn_year`,
 * so the cursor sinceToken is a year string (e.g. "2024").
 *
 * Legacy V0.5.6 cursor files stored YYYY-MM-DD from the broken adapter;
 * `parseSinceYear` accepts the leading YYYY of any such legacy value
 * transparently, avoiding a migration script.
 */

const MIN_YEAR = 1900;

export function parseSinceYear(token) {
    const m = String(token ?? '').match(/^\d{4}/);
    if (!m) return null;
    const y = parseInt(m[0], 10);
    const thisYear = new Date().getUTCFullYear();
    if (y < MIN_YEAR || y > thisYear + 1) return null;
    return y;
}

export function bootstrapSinceYear() {
    return new Date().getUTCFullYear() - 1;
}

export function resolveSinceYear(token) {
    return parseSinceYear(token) ?? bootstrapSinceYear();
}
