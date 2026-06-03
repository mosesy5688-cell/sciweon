/**
 * LOINC Cross-link Helpers -- PR-UMLS-4b pure functions for the trial<->loinc_concept
 * cross-link. Deterministic Token-Set Jaccard overlap. ZERO external / fuzzy deps (pure JS).
 *
 * ANCHOR (founder-locked, verified): trial.results.primary_outcomes[].title (the lab/outcome
 * MEASURE axis). NOT trial.conditions (that is the DISEASE axis = SNOMED territory = category
 * error). Secondary outcomes are OUT of scope (schema stores only secondary_outcomes_count --
 * no titles exist to match @ trial.js:138).
 *
 * ALGORITHM (founder-locked, NON-NEGOTIABLE):
 *   - Tokenizer: lowercase -> split on /[^a-z0-9]+/ -> drop tokens of length <= 2 ("at"/"of"/
 *     "in"/"by" noise) -> collect into a SET (dedup).
 *   - confidence = Jaccard = |A intersect B| / |A union B|, A = outcome-title token set,
 *     B = LOINC concept token set. Rounded to 2 decimals.
 *   - match_method literal = "token_set_jaccard".
 *   - The ONLY floor is Jaccard > 0 (no shared token = not a candidate = no link). NEVER drop
 *     by a confidence threshold (low-confidence links ARE published -- [[evidence_not_verdict]];
 *     the licensed CONSUMER filters, not the platform).
 *
 * COMPLIANCE (RULING 1 + cross-link policy, founder NON-NEGOTIABLE):
 *   - The PUBLIC link itemShape is EXACTLY { loinc_sid, confidence, match_method }. loinc_sid is
 *     the pure Sciweon SID hash (the concept's sid_s); confidence (numeric) + match_method
 *     (lineage tag) are 100% Sciweon-produced provenance. ZERO NLM/LOINC content (NO cui, NO
 *     code, NO str, NO preferred_str) ever enters a link. The researcher recovers code/str by
 *     joining loinc_sid into loinc-concepts-public.jsonl (this mirrors SNOMED's hash-only link).
 *   - Links are built by EXPLICIT field assignment (never object-spread a concept record), so
 *     cui can NEVER leak into the public link.
 *
 * DETERMINISM (GEMINI.md Sec 7, founder hard-constraint): NO Date.now() / Math.random() in any
 * output path; ordered iteration; stable tie-break (lowest sid_s lexicographically). A re-run
 * yields byte-identical loinc_links. The inverted token index (token -> array of {sid_s,
 * tokenSet}) is MANDATORY for tractability (avoids O(n^2) scan-all-concepts-per-title); its
 * candidate arrays preserve insertion order over the code-sorted concept stream, and the
 * resolve tie-break is fully deterministic regardless of candidate order.
 *
 * SYNONYM-UNION DECISION (documented): a concept's token set B is the UNION of the tokens of its
 * preferred_str AND every string in synonyms[] (deterministic; synonyms[] is already sorted by
 * the concept stream @ umls-concept-streams.js:156). This raises recall (a LOINC concept often
 * carries the clinically-used long name only in a synonym) without ever exposing the strings --
 * only the resulting sid_s hash is ever published.
 *
 * No-silent-drop per [[cross_cycle_silent_data_loss]]: every outcome title either resolves to a
 * link or is counted in no_match (loud bucketed telemetry). Idempotent (DECISION): the enricher
 * OVERWRITES trial.loinc_links; trial sid_s/sid_c are NEVER touched.
 */

export const MATCH_TOKEN_SET_JACCARD = 'token_set_jaccard';

/**
 * HALT guard (pure, unit-testable): a missing/empty LOINC concept file would silently zero every
 * trial's loinc_links. This enricher is wired immediately after the LOINC stamper + public
 * builder, so the stamped concept file MUST exist; 0 concepts -> THROW loud (no silent drop per
 * [[cross_cycle_silent_data_loss]]). The IO orchestrator calls this before enriching.
 */
export function assertLoincConceptsLoaded(concepts, label = 'LOINC-XLINK') {
    if (!Array.isArray(concepts) || concepts.length === 0) {
        throw new Error(`[${label}] HALT: 0 LOINC concepts loaded -- the F3 LOINC linker + stamper must run first; refusing to zero every trial's loinc_links (no silent drop)`);
    }
}

/**
 * Tokenize a string into a deduped SET of tokens. Lowercase, split on any non-alphanumeric run,
 * drop tokens of length <= 2 (short stop-word noise). Returns an empty Set for non-strings.
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
 * Token-Set Jaccard overlap = |A intersect B| / |A union B|, rounded to 2 decimals. Returns 0
 * when either set is empty (no union) or there is zero overlap (no candidate). Pure + total.
 */
export function jaccard(a, b) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const t of a) {
        if (b.has(t)) intersection++;
    }
    const union = a.size + b.size - intersection;
    if (union === 0) return 0;
    return Math.round((intersection / union) * 100) / 100;
}

/**
 * Build the concept token set B (preferred_str UNION synonyms[]; see SYNONYM-UNION DECISION).
 * Deterministic: synonyms[] arrives pre-sorted from the concept stream; we iterate in order.
 */
function conceptTokenSet(concept) {
    const set = tokenize(concept?.preferred_str);
    const syns = Array.isArray(concept?.synonyms) ? concept.synonyms : [];
    for (const syn of syns) {
        for (const tok of tokenize(syn)) set.add(tok);
    }
    return set;
}

/**
 * Build the INVERTED TOKEN INDEX over the FULL stamped LOINC concepts:
 *   token -> array of { sid_s, tokenSet }
 * Candidate generation (one outcome title -> all concepts sharing >= 1 token) reads this index
 * instead of scanning all concepts (avoids O(n_titles * n_concepts)). A concept missing sid_s
 * (un-stamped) is skipped + counted (the stamper must run first; a gap is surfaced, not joined
 * to undefined). A concept with an EMPTY token set contributes no index entries (it can never
 * be a Jaccard candidate). Insertion order follows the code-sorted concept stream (stable).
 */
export function buildLoincTokenIndex(concepts) {
    const index = new Map(); // token -> array of { sid_s, tokenSet }
    let missingSid = 0;
    let emptyTokenSet = 0;
    for (const c of concepts || []) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.sid_s !== 'string' || c.sid_s.length === 0) { missingSid++; continue; }
        const tokenSet = conceptTokenSet(c);
        if (tokenSet.size === 0) { emptyTokenSet++; continue; }
        const entry = { sid_s: c.sid_s, tokenSet };
        for (const tok of tokenSet) {
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
 * Resolve ONE outcome title to its single best LOINC link via Token-Set Jaccard.
 *
 * Candidate gen: gather every concept sharing >= 1 token with the title (via the inverted
 * index), dedup by sid_s (a concept indexed under N shared tokens appears once). Compute Jaccard
 * vs each candidate; pick the MAX. Deterministic tie-break: on equal Jaccard, the LOWEST sid_s
 * lexicographically wins (independent of candidate iteration order). Returns the PUBLIC link
 * { loinc_sid, confidence, match_method } if Jaccard > 0, else null (no shared token = no link).
 *
 * The link is built by EXPLICIT field assignment (never spread a concept) so cui can NEVER leak.
 */
export function resolveOutcomeTitle(title, index) {
    const titleTokens = tokenize(title);
    if (titleTokens.size === 0) return null;

    // Candidate set: union of the inverted-index buckets for the title's tokens, deduped by
    // sid_s (first occurrence keeps its tokenSet -- the tokenSet is identical per sid_s anyway).
    const candidates = new Map(); // sid_s -> tokenSet
    for (const tok of titleTokens) {
        const bucket = index.get(tok);
        if (!bucket) continue;
        for (const entry of bucket) {
            if (!candidates.has(entry.sid_s)) candidates.set(entry.sid_s, entry.tokenSet);
        }
    }
    if (candidates.size === 0) return null;

    let bestSid = null;
    let bestConfidence = 0;
    for (const [sid, tokenSet] of candidates) {
        const conf = jaccard(titleTokens, tokenSet);
        if (conf <= 0) continue;
        if (conf > bestConfidence || (conf === bestConfidence && (bestSid === null || sid < bestSid))) {
            bestConfidence = conf;
            bestSid = sid;
        }
    }
    if (bestSid === null || bestConfidence <= 0) return null;
    // EXPLICIT field assignment (no object spread) -- the public link allowlist is exactly
    // { loinc_sid, confidence, match_method }; cui/code/str can NEVER leak.
    return { loinc_sid: bestSid, confidence: bestConfidence, match_method: MATCH_TOKEN_SET_JACCARD };
}

/**
 * Compute loinc_links for ONE trial from its primary outcome titles. Iterates
 * trial.results.primary_outcomes[] in array order, resolves each .title, dedups across the
 * trial's outcomes by loinc_sid (FIRST-WRITE-WINS in outcome order). Mutates the shared
 * telemetry (terms_total / jaccard_hits / no_match). Fail-soft per-outcome (no throw). Returns
 * the PUBLIC links array (caller OVERWRITES trial.loinc_links -- idempotent). PUBLISHES ALL
 * links incl low confidence (NOT withheld -- consumer filters).
 */
export function buildLoincLinksForTrial(trial, index, telemetry) {
    const links = [];
    const seenSid = new Set();
    const outcomes = Array.isArray(trial?.results?.primary_outcomes) ? trial.results.primary_outcomes : [];
    for (const outcome of outcomes) {
        const title = outcome?.title;
        if (typeof title !== 'string' || title.length === 0) continue;
        telemetry.terms_total++;
        const link = resolveOutcomeTitle(title, index);
        if (!link) { noMatch(telemetry, `title:${title.slice(0, 80)}`); continue; }
        if (seenSid.has(link.loinc_sid)) continue; // dedup across the trial's outcomes (first-write-wins)
        seenSid.add(link.loinc_sid);
        links.push(link);
        telemetry.jaccard_hits++;
    }
    return links;
}

/**
 * Enrich all trials in place. Builds the inverted token index ONCE over the FULL stamped
 * (internal) LOINC concepts, then per-trial computes + OVERWRITES trial.loinc_links (idempotent).
 * Never touches sid_s/sid_c. Returns bucketed telemetry (loud, no silent drop).
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
