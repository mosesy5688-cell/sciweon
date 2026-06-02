/**
 * SNOMED Cross-link Helpers -- PR-UMLS-3 pure functions for the F2 disease<->snomed_concept
 * and trial<->snomed_concept cross-links.
 *
 * COMPLIANCE (RULING 1 + corrected CROSS-LINK POLICY, founder NON-NEGOTIABLE):
 *  - The PUBLIC link itemShape is EXACTLY { snomed_sid, confidence, match_method } -- the
 *    snomed_sid is the pure Sciweon SID hash; confidence (numeric scalar) + match_method
 *    (lineage tag) are 100% SCIWEON-PRODUCED provenance computed offline. ZERO NLM/SNOMED
 *    content (NO cui, NO code, NO str) ever enters a link.
 *  - PUBLISH ALL links (high AND low confidence). Low-confidence string-resolve links are
 *    NOT withheld -- withholding would be a pre-collapse (the platform judging "good enough"
 *    and hiding evidence, which [[evidence_not_verdict]] forbids). Every link carries its
 *    confidence + match_method so the licensed CONSUMER filters, not the platform.
 *
 * Three resolution channels (indices built from the FULL stamped internal snomed-concepts):
 *   byCode   `SNOMEDCT_US:<code>` in disease.db_xrefs -> exact_code_join (confidence 1.0)
 *   byCui    `UMLS:C<digits>`     in disease.db_xrefs -> cui_join        (confidence 0.95)
 *   byString normalized condition string (trial)      -> fuzzy_string_resolve (confidence 0.4)
 *
 * Fail-soft per [[scope_vs_quality_validation_segregation]]: one unresolved term increments a
 * bucket + continues; it NEVER aborts the record's other links. No-silent-drop per
 * [[cross_cycle_silent_data_loss]]: every term either resolves or is counted in no_match.
 *
 * Idempotent (DECISION): the enricher OVERWRITES record.snomed_links (no append-duplicate on
 * re-run); record sid_s/sid_c are NEVER touched.
 */

export const MATCH_EXACT_CODE = 'exact_code_join';
export const MATCH_CUI = 'cui_join';
export const MATCH_FUZZY_STRING = 'fuzzy_string_resolve';

export const CONFIDENCE_EXACT_CODE = 1.0;
export const CONFIDENCE_CUI = 0.95;
export const CONFIDENCE_FUZZY_STRING = 0.4;

export function normalizeSnomedString(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim().toLowerCase();
    return t.length > 0 ? t : null;
}

/**
 * Parse one disease db_xref string into a typed resolution key.
 *   `SNOMEDCT_US:80394007` / `SNOMEDCT:80394007` / `SNOMED:80394007` -> {kind:'code', value:'80394007'}
 *   `UMLS:C0001339`                                                   -> {kind:'cui',  value:'C0001339'}
 * Anything else -> null (not a SNOMED-resolvable xref). Case-insensitive prefix; OT db_xrefs
 * use a few SNOMED spellings, so we accept the common variants and key on the raw code.
 */
export function parseDiseaseXref(xref) {
    if (typeof xref !== 'string') return null;
    const idx = xref.indexOf(':');
    if (idx <= 0) return null;
    const prefix = xref.slice(0, idx).trim().toUpperCase();
    const value = xref.slice(idx + 1).trim();
    if (value.length === 0) return null;
    if (prefix === 'SNOMEDCT_US' || prefix === 'SNOMEDCT' || prefix === 'SNOMED' || prefix === 'SCTID') {
        return { kind: 'code', value };
    }
    if (prefix === 'UMLS' && /^C\d+$/.test(value)) {
        return { kind: 'cui', value };
    }
    return null;
}

/**
 * Build the CODE->sid_s index from FULL stamped SNOMED concepts. A concept missing sid_s
 * (un-stamped) is skipped + counted (the stamper must run first; a gap is surfaced).
 */
export function buildSnomedByCode(concepts) {
    const byCode = new Map();
    let missingSid = 0;
    for (const c of concepts || []) {
        if (!c || typeof c.code !== 'string' || c.code.length === 0) continue;
        if (typeof c.sid_s !== 'string' || c.sid_s.length === 0) { missingSid++; continue; }
        if (!byCode.has(c.code)) byCode.set(c.code, c.sid_s);
    }
    return { byCode, missingSid };
}

/**
 * Build the CUI->sid_s index. First-write-wins (one CUI -> one snomed_concept per the
 * harvest's atom collapse). A later distinct sid_s on an already-claimed CUI is a collision
 * (counted, NOT overwritten).
 */
export function buildSnomedByCui(concepts) {
    const byCui = new Map();
    let collisions = 0;
    for (const c of concepts || []) {
        if (!c || typeof c.sid_s !== 'string' || c.sid_s.length === 0) continue;
        if (typeof c.cui !== 'string' || c.cui.length === 0) continue;
        const existing = byCui.get(c.cui);
        if (!existing) byCui.set(c.cui, c.sid_s);
        else if (existing !== c.sid_s) collisions++;
    }
    return { byCui, collisions };
}

/**
 * Build the normalized-string->sid_s index over preferred_str + synonyms. First-write-wins;
 * a later distinct sid_s on an already-claimed key is a collision (counted, NOT overwritten).
 */
export function buildSnomedByString(concepts) {
    const byString = new Map();
    let collisions = 0;
    for (const c of concepts || []) {
        if (!c || typeof c.sid_s !== 'string' || c.sid_s.length === 0) continue;
        const strings = [c.preferred_str, ...(Array.isArray(c.synonyms) ? c.synonyms : [])];
        for (const raw of strings) {
            const key = normalizeSnomedString(raw);
            if (!key) continue;
            const existing = byString.get(key);
            if (!existing) byString.set(key, c.sid_s);
            else if (existing !== c.sid_s) collisions++;
        }
    }
    return { byString, collisions };
}

export const emptySnomedTelemetry = () => ({
    diseases_processed: 0, trials_processed: 0, terms_total: 0,
    exact_code_join_hits: 0, cui_join_hits: 0, fuzzy_string_resolve_hits: 0,
    no_match: 0, by_cui_collisions: 0, by_string_collisions: 0, no_match_samples: [],
});

// Push a PUBLIC link (allowlist shape) onto links, dedup by snomed_sid. ZERO NLM/SNOMED
// content -- snomed_sid is the pure hash; confidence + match_method are Sciweon provenance.
function pushLink(links, seenSid, sid, confidence, matchMethod) {
    if (seenSid.has(sid)) return false;
    seenSid.add(sid);
    links.push({ snomed_sid: sid, confidence, match_method: matchMethod });
    return true;
}

function noMatch(telemetry, sample) {
    telemetry.no_match++;
    if (telemetry.no_match_samples.length < 25) telemetry.no_match_samples.push(sample);
}

/**
 * Compute snomed_links for ONE disease from its db_xrefs (code_join + cui_join). Mutates
 * the shared telemetry. Fail-soft per-xref (try/continue, no throw). Returns the PUBLIC
 * links array (caller overwrites disease.snomed_links -- idempotent). PUBLISHES ALL links.
 */
export function buildSnomedLinksForDisease(disease, { byCode, byCui }, telemetry) {
    const links = [];
    const seenSid = new Set();
    for (const xref of Array.isArray(disease?.db_xrefs) ? disease.db_xrefs : []) {
        const parsed = parseDiseaseXref(xref);
        if (!parsed) continue; // not a SNOMED-resolvable xref (e.g. MONDO/EFO) -- not a no_match
        telemetry.terms_total++;
        if (parsed.kind === 'code') {
            const sid = byCode.get(parsed.value);
            if (sid) { if (pushLink(links, seenSid, sid, CONFIDENCE_EXACT_CODE, MATCH_EXACT_CODE)) telemetry.exact_code_join_hits++; }
            else noMatch(telemetry, `code:${parsed.value}`);
        } else { // cui
            const sid = byCui.get(parsed.value);
            if (sid) { if (pushLink(links, seenSid, sid, CONFIDENCE_CUI, MATCH_CUI)) telemetry.cui_join_hits++; }
            else noMatch(telemetry, `cui:${parsed.value}`);
        }
    }
    return links;
}

/**
 * Compute snomed_links for ONE trial from its bare-string conditions (fuzzy_string_resolve,
 * LOW confidence). Mutates telemetry. Fail-soft per-condition. Returns the PUBLIC links
 * array. PUBLISHES ALL links incl low-confidence (NOT withheld -- consumer filters).
 */
export function buildSnomedLinksForTrial(trial, { byString }, telemetry) {
    const links = [];
    const seenSid = new Set();
    for (const cond of Array.isArray(trial?.conditions) ? trial.conditions : []) {
        const key = normalizeSnomedString(cond);
        if (!key) continue;
        telemetry.terms_total++;
        const sid = byString.get(key);
        if (sid) { if (pushLink(links, seenSid, sid, CONFIDENCE_FUZZY_STRING, MATCH_FUZZY_STRING)) telemetry.fuzzy_string_resolve_hits++; }
        else noMatch(telemetry, `str:${key}`);
    }
    return links;
}

/**
 * Enrich all diseases + trials in place. Builds the three indices once over the FULL stamped
 * (internal) snomed concepts, then per-record computes + OVERWRITES record.snomed_links
 * (idempotent). Never touches sid_s/sid_c. Returns bucketed telemetry (loud, no silent drop).
 */
export function enrichWithSnomedLinks(diseases, trials, concepts) {
    const { byCode, missingSid } = buildSnomedByCode(concepts);
    const { byCui, collisions: cuiCollisions } = buildSnomedByCui(concepts);
    const { byString, collisions: strCollisions } = buildSnomedByString(concepts);
    const telemetry = emptySnomedTelemetry();
    telemetry.concepts_missing_sid = missingSid;
    telemetry.by_cui_collisions = cuiCollisions;
    telemetry.by_string_collisions = strCollisions;
    for (const d of diseases || []) {
        if (!d || typeof d !== 'object') continue;
        d.snomed_links = buildSnomedLinksForDisease(d, { byCode, byCui }, telemetry); // overwrite
        telemetry.diseases_processed++;
    }
    for (const t of trials || []) {
        if (!t || typeof t !== 'object') continue;
        t.snomed_links = buildSnomedLinksForTrial(t, { byString }, telemetry); // overwrite
        telemetry.trials_processed++;
    }
    return telemetry;
}
