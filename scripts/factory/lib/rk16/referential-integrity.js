/**
 * RK-16A2 — build-time EXHAUSTIVE referential-integrity attestation.
 *
 * For EVERY projection row, check the row's record_locator actually resolves to
 * a canonical record AND the identity + integrity bind:
 *   - the locator resolves (a canonical RecordLocator exists for it);
 *   - canonical_id matches between row and resolved locator;
 *   - canonical_content_hash matches the resolved locator's content_hash.
 *
 * Emits exhaustive counts + a stable attestation hash (canonicalManifestHash
 * over the sorted per-row results + counts). Default acceptance: zero dangling
 * references AND zero content-hash mismatches; assertCleanReferentialIntegrity
 * throws otherwise. PURE MECHANISM, OFFLINE/FIXTURE only.
 */

import { canonicalManifestHash } from '../snapshot-identity.js';

/**
 * @param {object[]} rows  projection rows (each has canonical_id,
 *   canonical_content_hash, record_locator).
 * @param {(loc:object)=>(object|undefined)} resolveLocator  returns the canonical
 *   RecordLocator for a row's record_locator, or undefined if it dangles. A
 *   simple resolver indexes the canonical writer's record_locators by a key.
 * @returns {{
 *   projection_record_count:number, canonical_resolved_count:number,
 *   dangling_reference_count:number, content_hash_mismatch_count:number,
 *   referential_integrity_attestation_hash:string
 * }}
 */
export function attestReferentialIntegrity(rows, resolveLocator) {
    const perRow = [];
    let resolved = 0;
    let dangling = 0;
    let mismatch = 0;

    for (const row of rows) {
        const loc = resolveLocator(row.record_locator);
        let status;
        if (!loc) {
            dangling += 1;
            status = 'dangling';
        } else {
            resolved += 1;
            const idMatch = loc.canonical_id === row.canonical_id;
            const hashMatch = loc.content_hash === row.canonical_content_hash;
            if (!idMatch || !hashMatch) {
                mismatch += 1;
                status = !idMatch ? 'id_mismatch' : 'content_hash_mismatch';
            } else {
                status = 'ok';
            }
        }
        perRow.push({ canonical_id: String(row.canonical_id), status });
    }

    perRow.sort((a, b) =>
        a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1
            : a.status < b.status ? -1 : a.status > b.status ? 1 : 0);

    const counts = {
        projection_record_count: rows.length,
        canonical_resolved_count: resolved,
        dangling_reference_count: dangling,
        content_hash_mismatch_count: mismatch,
    };

    const attestation_hash = canonicalManifestHash({ per_row: perRow, counts });

    return {
        ...counts,
        referential_integrity_attestation_hash: attestation_hash,
    };
}

/**
 * Throw unless the attestation is CLEAN (default acceptance):
 * dangling_reference_count === 0 AND content_hash_mismatch_count === 0.
 */
export function assertCleanReferentialIntegrity(attestation) {
    const { dangling_reference_count: d, content_hash_mismatch_count: m } = attestation;
    if (d !== 0 || m !== 0) {
        throw new Error(
            `[REFERENTIAL-INTEGRITY] NOT clean — dangling_reference_count=${d}, ` +
            `content_hash_mismatch_count=${m} (must both be 0).`,
        );
    }
}
