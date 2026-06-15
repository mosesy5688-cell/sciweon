// @ts-nocheck
/**
 * RK-16A2 test fixture — a GENERIC fixture family (NO business policy).
 *
 * Provides a tiny FamilyPolicy.project() and helpers to build canonical records
 * + projection rows for the substrate round-trip tests. Uses NO real family
 * semantics (no is_active / activity_type / CHEMBL / verdict) — partition names
 * are arbitrary fixture strings.
 */

import { contentHash, projectionHash } from '../../../scripts/factory/lib/rk16/content-hash.js';

export const FIXTURE_PROJECTION_SCHEMA_VERSION = 'fixture-proj-v1';

/** A fixture FamilyPolicy: projects a canonical record into a projection row. */
export const fixtureFamilyPolicy = {
    family_id: 'fixture_family',
    projection_schema_version: FIXTURE_PROJECTION_SCHEMA_VERSION,
    /** Pure, reproducible projection: same (canonical, locator) -> same row. */
    project(canonical, locator) {
        const row = {
            canonical_id: canonical.id,
            canonical_content_hash: locator.content_hash,
            projection_schema_version: FIXTURE_PROJECTION_SCHEMA_VERSION,
            record_locator: locator,
            // a generic filterable column (fixture only, no business meaning)
            tag: canonical.tag,
        };
        return { ...row, projection_hash: projectionHash(row) };
    },
};

/** Build N fixture canonical records {canonical_id, record}. */
export function makeCanonicalRecords(n, prefix = 'FX') {
    const out = [];
    for (let i = 0; i < n; i++) {
        const id = `${prefix}:${String(1000 + i)}`;
        out.push({
            canonical_id: id,
            // intentionally unsorted keys to prove canonicalize() sorts them
            record: { tag: i % 3 === 0 ? 'A' : 'B', id, payload: `body-${i}`, n: i },
        });
    }
    return out;
}

export { contentHash };
