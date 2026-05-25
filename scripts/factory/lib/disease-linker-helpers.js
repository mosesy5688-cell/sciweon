/**
 * Disease linker pure-function helpers (cycle 23 PR-SID-1.6b-pre.1b).
 *
 * Extracted from scripts/factory/disease-linker.js orchestrator so unit
 * tests import without triggering main() / R2 client side-effects. Same
 * pattern as lib/target-linker-helpers.js separation.
 *
 * Responsibilities:
 *   - buildDiseaseRecord: enrich one OT raw disease record into the Sciweon-
 *     namespaced disease entity shape (parses namespace, attaches canon_version
 *     + anchor_payload, retains all OT metadata, builds provenance)
 *   - dedupeBySciweonId: collapse duplicate raw OT IDs that normalize to the
 *     same anchor (defensive — OT corpus inspected 2026-05-25 had no dupes
 *     across 47K but tail-fuse + future releases may introduce them)
 *   - buildTelemetryBuckets: 3-bucket skip telemetry (unparseable / dedup /
 *     missing_required_field) for Plan-A1 transparency per [[cross_cycle_silent_data_loss]]
 */

import { parseDiseaseIdNamespace, PRIMARY_NAMESPACE_MAP, TAIL_FUSE_NAMESPACE } from '../../../src/lib/schemas/disease.js';

export const LINKER_LABEL = 'DISEASE-LINKER';

function safeStringList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(s => typeof s === 'string' && s.length > 0);
}

function safeSynonyms(syn) {
    if (!syn || typeof syn !== 'object') return null;
    return {
        has_exact_synonym: safeStringList(syn.has_exact_synonym),
        has_related_synonym: safeStringList(syn.has_related_synonym),
        has_broad_synonym: safeStringList(syn.has_broad_synonym),
        has_narrow_synonym: safeStringList(syn.has_narrow_synonym),
    };
}

/**
 * Build one Sciweon disease record from a raw OT disease ingest row.
 * Returns `{ record }` on success or `{ skip: <reason> }` on filterable input.
 *
 * Skip reasons (counted explicitly by orchestrator per Plan-A1 telemetry):
 *   - missing_disease_id     row has no raw disease_id field
 *   - unparseable_disease_id raw id does not match [A-Za-z]+_<rest> shape
 */
export function buildDiseaseRecord(otRow, nowIso) {
    if (!otRow || typeof otRow !== 'object') return { skip: 'missing_disease_id' };
    const rawDiseaseId = otRow.disease_id;
    if (typeof rawDiseaseId !== 'string' || rawDiseaseId.length === 0) {
        return { skip: 'missing_disease_id' };
    }
    const parsed = parseDiseaseIdNamespace(rawDiseaseId);
    if (!parsed) return { skip: 'unparseable_disease_id' };

    return {
        record: {
            id: parsed.sciweon_id,
            raw_disease_id: rawDiseaseId,
            namespace: parsed.namespace,
            ontology_prefix: parsed.ontology_prefix,
            numeric_id: parsed.numeric_id,
            anchor_payload: parsed.anchor_payload,
            canonicalization_version: parsed.canonicalization_version,
            name: typeof otRow.name === 'string' ? otRow.name : null,
            description: typeof otRow.description === 'string' ? otRow.description : null,
            synonyms: safeSynonyms(otRow.synonyms),
            therapeutic_areas: safeStringList(otRow.therapeutic_areas),
            parents: safeStringList(otRow.parents),
            ancestors: safeStringList(otRow.ancestors),
            db_xrefs: safeStringList(otRow.db_xrefs),
            code: typeof otRow.code === 'string' ? otRow.code : null,
            provenance: {
                sources: [{ source: 'open_targets', source_id: rawDiseaseId, timestamp: nowIso }],
                last_updated: nowIso,
            },
            license_metadata: otRow.license_metadata && typeof otRow.license_metadata === 'object'
                ? otRow.license_metadata
                : null,
        },
    };
}

/**
 * Collapse multiple records sharing the same Sciweon id into a single entry.
 * First record wins (deterministic by ingest order); duplicate count returned
 * for telemetry. Tail-fuse anchor_payload preserves full raw id so primary
 * namespace records cannot collide with tail-fuse records by construction.
 */
export function dedupeBySciweonId(records) {
    if (!Array.isArray(records)) throw new Error(`[${LINKER_LABEL}] records must be array`);
    const seen = new Map();
    let duplicates = 0;
    for (const rec of records) {
        if (!rec || typeof rec.id !== 'string') continue;
        if (seen.has(rec.id)) { duplicates++; continue; }
        seen.set(rec.id, rec);
    }
    return { deduped: Array.from(seen.values()), duplicates };
}

/**
 * Per-namespace count aggregator for orchestrator summary.
 * Returns object keyed by namespace with per-namespace record counts.
 */
export function buildNamespaceCounts(records) {
    const counts = {};
    for (const ns of Object.values(PRIMARY_NAMESPACE_MAP)) counts[ns] = 0;
    counts[TAIL_FUSE_NAMESPACE] = 0;
    for (const rec of records) {
        if (rec && typeof rec.namespace === 'string' && Object.prototype.hasOwnProperty.call(counts, rec.namespace)) {
            counts[rec.namespace]++;
        }
    }
    return counts;
}
