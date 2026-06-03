/**
 * LOINC Cross-link Helpers -- PR-UMLS-4b pure functions for the trial<->loinc_concept
 * cross-link. Deterministic Token-Set Jaccard overlap. ZERO external / fuzzy deps (pure JS).
 *
 * ANCHOR (founder-locked, verified): trial.results.primary_outcomes[].title (the lab/outcome
 * MEASURE axis). NOT trial.conditions (DISEASE axis = SNOMED territory = category error).
 * Secondary outcomes are OUT of scope (schema stores only secondary_outcomes_count @ trial.js:138).
 *
 * ALGORITHM (founder-locked, NON-NEGOTIABLE):
 *   - Tokenizer: lowercase -> split on /[^a-z0-9]+/ -> drop tokens of length <= 2 -> SET (dedup).
 *   - confidence = Jaccard = |A int B| / |A un B|, A = title token set, B = a concept STRING
 *     token set (per-string MAX -- see PER-STRING-MAX DECISION). match_method = "token_set_jaccard".
 *   - The ONLY floor is RAW (UNROUNDED) Jaccard > 0 (FIX 3): the floor is gated on the raw ratio,
 *     NOT the rounded value. A genuine but tiny overlap whose raw Jaccard rounds to 0.00 is
 *     PUBLISHED at confidence = max(0.01, round(raw,2)), never dropped + never mislabeled
 *     no_match. NEVER drop by a confidence threshold (low-confidence links ARE published --
 *     [[evidence_not_verdict]]; the licensed CONSUMER filters, not the platform).
 *
 * COMPLIANCE (RULING 1 + cross-link policy, founder NON-NEGOTIABLE): the PUBLIC link itemShape is
 * EXACTLY { loinc_sid, confidence, match_method }. loinc_sid = the pure Sciweon SID hash (sid_s);
 * confidence + match_method are 100% Sciweon provenance. ZERO NLM/LOINC content (NO cui, code, str,
 * preferred_str) ever enters a link (researcher recovers code/str by joining loinc_sid into
 * loinc-concepts-public.jsonl; mirrors SNOMED). Links built by EXPLICIT field assignment (never
 * object-spread a concept) so cui can NEVER leak.
 *
 * DETERMINISM (GEMINI.md Sec 7, founder hard-constraint): NO Date.now() / Math.random(); ordered
 * iteration; stable tie-break (lowest sid_s lexicographically); per-sid dedup + sort-by-sid make a
 * re-run byte-identical regardless of outcome order. The inverted token index (token -> array of
 * {sid_s, tokenSets}) is MANDATORY for tractability (avoids O(n^2)); candidate arrays preserve
 * insertion order over the code-sorted concept stream.
 *
 * PER-STRING-MAX DECISION (PR-4b review FIX 1, supersedes the prior synonym-UNION): a concept
 * carries a LIST of per-string token sets [tokenize(preferred_str), tokenize(syn1), ...] (empties
 * dropped); its confidence = MAX Jaccard over those individual string sets, NOT a single Jaccard
 * over the union. Rationale: unioning preferred_str + all synonyms inflated |B|, deflating the
 * Jaccard so argmax systematically picked the SPARSE concept over the canonical one. Per-string
 * max keeps full recall (a long name carried only in a synonym still matches) without the synonym-
 * count bias. synonyms[] is pre-sorted @ umls-concept-streams.js:156 so the max over a fixed
 * ordered list is deterministic. Only sid_s is ever published.
 *
 * No-silent-drop per [[cross_cycle_silent_data_loss]]: every title either resolves or is counted
 * in no_match (loud telemetry). Idempotent: the enricher OVERWRITES trial.loinc_links; sid_s/sid_c
 * are NEVER touched.
 */

export const MATCH_TOKEN_SET_JACCARD = 'token_set_jaccard';

/**
 * HALT guard (pure, unit-testable): a missing/empty LOINC concept file would silently zero every
 * trial's loinc_links. The enricher is wired after the LOINC stamper + public builder, so the
 * concept file MUST exist; 0 concepts -> THROW loud (no silent drop per
 * [[cross_cycle_silent_data_loss]]). The IO orchestrator calls this before enriching.
 */
export function assertLoincConceptsLoaded(concepts, label = 'LOINC-XLINK') {
    if (!Array.isArray(concepts) || concepts.length === 0) {
        throw new Error(`[${label}] HALT: 0 LOINC concepts loaded -- the F3 LOINC linker + stamper must run first; refusing to zero every trial's loinc_links (no silent drop)`);
    }
}

/**
 * HALT guard (PR-4b review FIX 2 belt-and-suspenders): trials are PRODUCED upstream (before the
 * UMLS cascade), so 0 trials at the enricher is an anomaly. We must NOT proceed to
 * writeJsonl(trialsPath, []) which would OVERWRITE trials.jsonl with empty content (silent total
 * data loss). 0 trials -> THROW loud; with loadJsonl's ENOENT-only swallow, a read/parse failure
 * HALTs instead of truncating.
 */
export function assertTrialsLoaded(trials, label = 'LOINC-XLINK') {
    if (!Array.isArray(trials) || trials.length === 0) {
        throw new Error(`[${label}] HALT: 0 trials loaded -- trials are produced before the UMLS cascade; refusing to overwrite trials.jsonl with empty content (no silent data loss)`);
    }
}

/**
 * Tokenize a string into a deduped SET: lowercase, split on any non-alphanumeric run, drop tokens
 * of length <= 2 (short stop-word noise). Returns an empty Set for non-strings.
 */
export function tokenize(str) {
    const set = new Set();
    if (typeof str !== 'string') return set;
    for (const tok of str.toLowerCase().split(/[^a-z0-9]+/)) {
        if (tok.length > 2) set.add(tok);
    }
    return set;
}

/**
 * RAW Token-Set Jaccard = |A int B| / |A un B|, UNROUNDED (FIX 3). 0 when either set is empty or
 * there is zero overlap. The raw ratio is what the floor (>0) is gated on; round+clamp at the call
 * site. resolve uses jaccardRaw directly so the floor + 0.01 clamp see the true overlap.
 */
export function jaccardRaw(a, b) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const t of a) {
        if (b.has(t)) intersection++;
    }
    const union = a.size + b.size - intersection;
    if (union === 0) return 0;
    return intersection / union;
}

/** Token-Set Jaccard rounded to 2 decimals (convenience wrapper over jaccardRaw). */
export function jaccard(a, b) {
    return Math.round(jaccardRaw(a, b) * 100) / 100;
}

// Build a concept's LIST of per-string token sets (FIX 1): [tokenize(preferred_str),
// tokenize(syn1), ...] EMPTY sets dropped. synonyms[] arrives pre-sorted (deterministic).
function conceptTokenSetList(concept) {
    const list = [];
    const pref = tokenize(concept?.preferred_str);
    if (pref.size > 0) list.push(pref);
    const syns = Array.isArray(concept?.synonyms) ? concept.synonyms : [];
    for (const syn of syns) {
        const s = tokenize(syn);
        if (s.size > 0) list.push(s);
    }
    return list;
}

/**
 * Build the INVERTED TOKEN INDEX over the FULL stamped LOINC concepts (FIX 1):
 *   token -> array of { sid_s, tokenSets }   (tokenSets = the per-string token-set LIST)
 * Candidacy ONLY: a concept is indexed under the UNION of its strings' tokens (a title hits all
 * concepts sharing >= 1 token with ANY string; avoids O(n_titles*n_concepts)). resolve scores
 * per-string MAX from the stored tokenSets list (NOT the union -- union is candidacy plumbing). A
 * concept missing sid_s is skipped + counted; one with no non-empty string set adds no entries.
 */
export function buildLoincTokenIndex(concepts) {
    const index = new Map(); // token -> array of { sid_s, tokenSets }
    let missingSid = 0;
    let emptyTokenSet = 0;
    for (const c of concepts || []) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.sid_s !== 'string' || c.sid_s.length === 0) { missingSid++; continue; }
        const tokenSets = conceptTokenSetList(c);
        if (tokenSets.length === 0) { emptyTokenSet++; continue; }
        const entry = { sid_s: c.sid_s, tokenSets };
        const union = new Set(); // candidacy union: every distinct token across the concept's strings
        for (const set of tokenSets) for (const tok of set) union.add(tok);
        for (const tok of union) {
            const bucket = index.get(tok);
            if (bucket) bucket.push(entry);
            else index.set(tok, [entry]);
        }
    }
    return { index, missingSid, emptyTokenSet };
}

export const emptyLoincTelemetry = () => ({
    trials_processed: 0, terms_total: 0, jaccard_hits: 0, no_match: 0,
    by_token_index_size: 0, concepts_missing_sid: 0, concepts_empty_tokenset: 0,
    no_match_samples: [],
});

function noMatch(telemetry, sample) {
    telemetry.no_match++;
    if (telemetry.no_match_samples.length < 25) telemetry.no_match_samples.push(sample);
}

/**
 * Resolve ONE outcome title to its single best LOINC link via per-string-max Token-Set Jaccard.
 * Candidates = concepts sharing >= 1 token (inverted index), deduped by sid_s. Score = MAX RAW
 * Jaccard over a candidate's per-string token sets (FIX 1: not one Jaccard over the union). Compare
 * /tie-break on the RAW ratio (FIX 3); equal raw -> LOWEST sid_s wins. FLOOR RAW > 0 (FIX 3):
 * winner's confidence = max(0.01, round(raw,2)) so a tiny real overlap ships at 0.01, never
 * dropped/mislabeled. Returns the PUBLIC link or null. EXPLICIT field assignment.
 */
export function resolveOutcomeTitle(title, index) {
    const titleTokens = tokenize(title);
    if (titleTokens.size === 0) return null;

    // Candidates: inverted-index buckets for the title's tokens, deduped by sid_s.
    const candidates = new Map(); // sid_s -> tokenSets (per-string list)
    for (const tok of titleTokens) {
        const bucket = index.get(tok);
        if (!bucket) continue;
        for (const entry of bucket) {
            if (!candidates.has(entry.sid_s)) candidates.set(entry.sid_s, entry.tokenSets);
        }
    }
    if (candidates.size === 0) return null;

    let bestSid = null;
    let bestRaw = 0;
    for (const [sid, tokenSets] of candidates) {
        let raw = 0; // per-string MAX (FIX 1): best Jaccard over the concept's strings
        for (const set of tokenSets) {
            const r = jaccardRaw(titleTokens, set);
            if (r > raw) raw = r;
        }
        if (raw <= 0) continue;
        if (raw > bestRaw || (raw === bestRaw && (bestSid === null || sid < bestSid))) {
            bestRaw = raw;
            bestSid = sid;
        }
    }
    if (bestSid === null || bestRaw <= 0) return null;
    // FIX 3: floor on RAW > 0; a tiny overlap ships at 0.01 (never 0.00 / never dropped).
    const confidence = Math.max(0.01, Math.round(bestRaw * 100) / 100);
    // EXPLICIT field assignment (no spread) -- allowlist {loinc_sid,confidence,match_method} only.
    return { loinc_sid: bestSid, confidence, match_method: MATCH_TOKEN_SET_JACCARD };
}

/**
 * Compute loinc_links for ONE trial from its primary outcome titles. Resolves each
 * trial.results.primary_outcomes[].title, then dedups across outcomes by loinc_sid keeping the
 * MAXIMUM confidence per sid (FIX 4: a later outcome -> same sid @ HIGHER confidence WINS; the
 * prior first-write-wins silently discarded it; equal confidence keeps first). Final array SORTED
 * by loinc_sid lexicographic (FIX 4) -> byte-deterministic regardless of outcome order. Mutates
 * telemetry (terms_total / no_match; jaccard_hits = DISTINCT links per sid). Fail-soft per-outcome.
 * Caller OVERWRITES trial.loinc_links (idempotent). ALL links published.
 */
export function buildLoincLinksForTrial(trial, index, telemetry) {
    const bySid = new Map(); // loinc_sid -> best link (max confidence, first on tie)
    const outcomes = Array.isArray(trial?.results?.primary_outcomes) ? trial.results.primary_outcomes : [];
    for (const outcome of outcomes) {
        const title = outcome?.title;
        if (typeof title !== 'string' || title.length === 0) continue;
        telemetry.terms_total++;
        const link = resolveOutcomeTitle(title, index);
        if (!link) { noMatch(telemetry, `title:${title.slice(0, 80)}`); continue; }
        const prior = bySid.get(link.loinc_sid);
        // Keep the MAX confidence per sid; strictly-greater replaces (equal keeps first).
        if (!prior || link.confidence > prior.confidence) bySid.set(link.loinc_sid, link);
    }
    telemetry.jaccard_hits += bySid.size; // distinct published links (per sid), honest telemetry
    // Sort by loinc_sid lexicographically -> byte-deterministic regardless of outcome order.
    return [...bySid.values()].sort((a, b) => (a.loinc_sid < b.loinc_sid ? -1 : a.loinc_sid > b.loinc_sid ? 1 : 0));
}

/**
 * Enrich all trials in place. Builds the inverted token index ONCE over the FULL stamped (internal)
 * LOINC concepts, then per-trial computes + OVERWRITES trial.loinc_links (idempotent). Never
 * touches sid_s/sid_c. Returns bucketed telemetry.
 */
export function enrichTrialsWithLoincLinks(trials, concepts) {
    const { index, missingSid, emptyTokenSet } = buildLoincTokenIndex(concepts);
    const telemetry = emptyLoincTelemetry();
    telemetry.by_token_index_size = index.size;
    telemetry.concepts_missing_sid = missingSid;
    telemetry.concepts_empty_tokenset = emptyTokenSet;
    for (const t of trials || []) {
        if (!t || typeof t !== 'object') continue;
        t.loinc_links = buildLoincLinksForTrial(t, index, telemetry); // overwrite -> idempotent
        telemetry.trials_processed++;
    }
    return telemetry;
}
