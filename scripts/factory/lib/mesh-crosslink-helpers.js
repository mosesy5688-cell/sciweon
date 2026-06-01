/**
 * MeSH Cross-link Helpers -- PR-UMLS-2 pure functions for the F2 paper<->mesh_concept
 * cross-link (DECISION 5: paper-only in PR-2; disease.db_xrefs + trial.conditions
 * are documented follow-on).
 *
 * Two resolution channels:
 *   Part A (code_join, high confidence): paper.mesh_descriptors[].ui is the MSH
 *     D-code; join directly to mesh_concept by CODE (byCode map). DECISION 2:
 *     this is the deterministic D-subset path.
 *   Part B (string_resolve, low confidence): a FALLBACK only for paper.mesh_terms
 *     strings that have NO corresponding mesh_descriptors code (historical papers
 *     that predate the descriptor_ui re-plumb); resolve against the normalized
 *     preferred_str + synonym map (byString).
 *
 * Fail-soft per [[scope_vs_quality_validation_segregation]]: one unresolved term
 * increments a bucket + continues; it NEVER aborts the paper's other links.
 * No-silent-drop per [[cross_cycle_silent_data_loss]]: every term either
 * code-joins, string-resolves, or is counted in no_match (loud telemetry).
 *
 * Idempotent (DECISION 3): the enricher OVERWRITES paper.mesh_links (no append-
 * duplicate on re-run); paper sid_s/sid_c are NEVER touched.
 */

export function normalizeMeshString(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim().toLowerCase();
    return t.length > 0 ? t : null;
}

/**
 * Build the CODE->{sid_s,cui} index from stamped mesh concepts. A concept missing
 * sid_s (un-stamped) is skipped + counted (the stamper must run first; a gap is
 * surfaced, not silently joined to undefined).
 */
export function buildMeshByCode(concepts) {
    const byCode = new Map();
    let missingSid = 0;
    for (const c of concepts || []) {
        if (!c || typeof c.code !== 'string' || c.code.length === 0) continue;
        if (typeof c.sid_s !== 'string' || c.sid_s.length === 0) { missingSid++; continue; }
        if (!byCode.has(c.code)) byCode.set(c.code, { sid_s: c.sid_s, cui: c.cui ?? null });
    }
    return { byCode, missingSid };
}

/**
 * Build the normalized-string->{sid_s,code} index over preferred_str + synonyms.
 * First-write-wins; a later distinct sid_s mapping to an already-claimed key is a
 * collision (counted, NOT overwritten). Concepts without sid_s are skipped.
 */
export function buildMeshByString(concepts) {
    const byString = new Map();
    let collisions = 0;
    for (const c of concepts || []) {
        if (!c || typeof c.sid_s !== 'string' || c.sid_s.length === 0 || typeof c.code !== 'string') continue;
        const strings = [c.preferred_str, ...(Array.isArray(c.synonyms) ? c.synonyms : [])];
        for (const raw of strings) {
            const key = normalizeMeshString(raw);
            if (!key) continue;
            const existing = byString.get(key);
            if (!existing) {
                byString.set(key, { sid_s: c.sid_s, code: c.code });
            } else if (existing.sid_s !== c.sid_s) {
                collisions++; // first-write-wins; distinct concept claimed same string
            }
        }
    }
    return { byString, collisions };
}

const emptyTelemetry = () => ({
    papers_processed: 0, terms_total: 0,
    code_join_hits: 0, string_resolve_hits: 0, no_match: 0,
    string_map_collisions: 0, no_match_samples: [],
});

/**
 * Compute mesh_links for ONE paper. Part A over mesh_descriptors (code_join), then
 * Part B over mesh_terms whose code is NOT already covered by a descriptor
 * (string_resolve fallback). Mutates the shared telemetry object. Fail-soft:
 * per-term try/continue, no throw. Returns the links array (caller overwrites
 * paper.mesh_links -- idempotent).
 */
export function buildMeshLinksForPaper(paper, { byCode, byString }, telemetry) {
    const links = [];
    const seenSid = new Set();
    const descriptorCodes = new Set();

    // Part A: deterministic D-code join.
    for (const d of Array.isArray(paper?.mesh_descriptors) ? paper.mesh_descriptors : []) {
        const ui = d?.ui;
        if (typeof ui !== 'string' || ui.length === 0) continue;
        descriptorCodes.add(ui);
        telemetry.terms_total++;
        const hit = byCode.get(ui);
        if (hit && !seenSid.has(hit.sid_s)) {
            seenSid.add(hit.sid_s);
            links.push({ mesh_sid: hit.sid_s, code: ui, match: 'code_join', confidence: 'high' });
            telemetry.code_join_hits++;
        } else if (!hit) {
            telemetry.no_match++;
            if (telemetry.no_match_samples.length < 25) telemetry.no_match_samples.push(`code:${ui}`);
        }
    }

    // Part B: string-resolve fallback ONLY for mesh_terms with no descriptor code.
    // A historical paper carries mesh_terms (strings) but no mesh_descriptors codes,
    // so descriptorCodes is empty and every term routes here.
    for (const term of Array.isArray(paper?.mesh_terms) ? paper.mesh_terms : []) {
        const key = normalizeMeshString(term);
        if (!key) continue;
        const resolved = byString.get(key);
        // Skip if this term's concept was already covered by a descriptor code-join.
        if (resolved && descriptorCodes.has(resolved.code)) continue;
        telemetry.terms_total++;
        if (resolved && !seenSid.has(resolved.sid_s)) {
            seenSid.add(resolved.sid_s);
            links.push({ mesh_sid: resolved.sid_s, code: resolved.code, match: 'string_resolve', confidence: 'low' });
            telemetry.string_resolve_hits++;
        } else if (!resolved) {
            telemetry.no_match++;
            if (telemetry.no_match_samples.length < 25) telemetry.no_match_samples.push(`str:${key}`);
        }
    }

    return links;
}

/**
 * Enrich all papers in place. Builds the two indices once, then per-paper computes
 * + OVERWRITES paper.mesh_links (idempotent). Never touches sid_s/sid_c. Returns
 * the bucketed telemetry (loud, no silent drop).
 */
export function enrichPapersWithMeshLinks(papers, concepts) {
    const { byCode, missingSid } = buildMeshByCode(concepts);
    const { byString, collisions } = buildMeshByString(concepts);
    const telemetry = emptyTelemetry();
    telemetry.string_map_collisions = collisions;
    telemetry.concepts_missing_sid = missingSid;
    for (const paper of papers || []) {
        if (!paper || typeof paper !== 'object') continue;
        const links = buildMeshLinksForPaper(paper, { byCode, byString }, telemetry);
        paper.mesh_links = links; // overwrite -> idempotent on re-run
        telemetry.papers_processed++;
    }
    return telemetry;
}
