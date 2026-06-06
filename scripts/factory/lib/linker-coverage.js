/**
 * Linker coverage helpers (PR-B coverage-ceiling) -- shared by trial-linker.js
 * and paper-linker.js.
 *
 * THE BUG THIS KILLS (B2 stage-audit finding): trial-linker / paper-linker used
 * a fixed LIMIT=50 and the F3 orchestrator passes no argv, so only the OLDEST 50
 * of the ~7,312-trial / ~16,011-paper corpus ever got a fresh CT.gov / OpenAlex
 * query per run. The linkers exit 0, so this permanent coverage CEILING was
 * SILENT -- it violates the founder's preserve-all ruling (cover everything over
 * time, no volume cut at ingest).
 *
 * THE FIX: a per-compound freshness STAMP (linkage.trials_queried_at /
 * linkage.papers_queried_at, ISO-8601) + a skip-if-fresh eligibility predicate
 * lets the existing enrichment-cursor drain advance across daily runs through
 * ALL compounds, re-querying each only after its freshness window lapses. This
 * mirrors the established "cursor + skip-if-stamped" convention
 * (compound-faers-enricher.js / compound-rxnorm-enricher.js) -- but with a
 * WINDOWED timestamp (re-query after staleness) rather than a one-shot boolean
 * stamp, because trial/paper coverage must REFRESH over time, not freeze once.
 *
 * PRESERVE-ALL: this is a CADENCE mechanism, never a cap. Every compound is
 * eligible the moment its stamp is absent or older than the window; the cursor
 * reaches all of them in O(N / chunk_size) runs. There is NO Top-N, relevance,
 * or volume cut anywhere.
 *
 * DETERMINISM (GEMINI.md Sec 7): the pure predicates take `nowMs` as a parameter
 * (captured ONCE per run by the caller) so identical input + identical nowMs ->
 * identical output. No Date.now() / Math.random() inside these helpers.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Default freshness windows. Trials re-queried every 30 days, papers every 45.
// (Trials change status more often -- a TERMINATED/COMPLETED transition is the
// Negative-Evidence signal we must not miss -- so a tighter window; papers
// accrue more slowly.) No existing windowed-freshness convention was found in
// the codebase (the FAERS/RxNorm enrichers use a one-shot boolean stamp with NO
// re-query window), so these are introduced here and documented as the SSoT;
// env-overridable for ops tuning per [[solo_repo_branch_protection]].
export const DEFAULT_TRIALS_FRESHNESS_DAYS = 30;
export const DEFAULT_PAPERS_FRESHNESS_DAYS = 45;

export const TRIALS_STAMP_FIELD = 'trials_queried_at';
export const PAPERS_STAMP_FIELD = 'papers_queried_at';

/**
 * Read a compound's queried-at stamp (ISO string) for the given stamp field, or
 * null when absent. Lives under record.linkage.<stampField>.
 */
export function getQueriedAt(record, stampField) {
    const v = record?.linkage?.[stampField];
    return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Is this compound's stamp FRESH (within `freshnessDays` of nowMs)? A missing or
 * unparseable stamp is NOT fresh (so it is eligible -- never silently skipped).
 * A future-dated stamp (clock skew) counts as fresh (don't re-query churn).
 *
 * @param {object} record
 * @param {string} stampField  TRIALS_STAMP_FIELD | PAPERS_STAMP_FIELD
 * @param {number} freshnessDays
 * @param {number} nowMs        caller-captured Date.now(), passed for determinism
 */
export function isFresh(record, stampField, freshnessDays, nowMs) {
    const stamp = getQueriedAt(record, stampField);
    if (stamp == null) return false;
    const t = Date.parse(stamp);
    if (Number.isNaN(t)) return false; // unparseable -> treat as never-queried (eligible)
    const ageMs = nowMs - t;
    if (ageMs < 0) return true; // future stamp (skew) -> consider fresh, don't churn
    return ageMs < freshnessDays * MS_PER_DAY;
}

/**
 * Eligibility = NOT fresh. A compound is eligible for a fresh query iff its stamp
 * is absent or older than the freshness window. This is the cursor's denominator
 * predicate and the skip-if-fresh guard, in one place.
 */
export function isEligibleForQuery(record, stampField, freshnessDays, nowMs) {
    return !isFresh(record, stampField, freshnessDays, nowMs);
}

/**
 * Stamp a compound as queried-at `nowIso`. Mutates record.linkage in place
 * (creating linkage if absent). Additive: never touches other linkage fields.
 * Returns the record for chaining.
 */
export function stampQueriedAt(record, stampField, nowIso) {
    if (record.linkage == null || typeof record.linkage !== 'object') record.linkage = {};
    record.linkage[stampField] = nowIso;
    return record;
}

/**
 * COVERAGE-INVARIANT VERDICT ([[cross_cycle_silent_data_loss]]) -- the
 * frozen-cursor-vs-outage discriminator (PR-1 F3 outage-decouple).
 *
 * If there were eligible compounds this run but ZERO got queried, EITHER the
 * cursor is frozen/stuck (a real bug -- the B2 regression) OR every compound in
 * the chunk hit a 3rd-party OUTAGE (OpenAlex 429 / CT.gov 5xx / S2 outage). The
 * two are NOT the same incident and must NOT share an exit code:
 *
 *   - FROZEN CURSOR (queried==0 AND queryErrorCount==0): nothing advanced WITH NO
 *     errors -> a genuine drain/cursor bug. THROW LOUD (HALT, unchanged message)
 *     so F3 exits 1 and F4 does NOT publish a broken run. Mirrors the sibling
 *     record-count guards (uniprot-target-enrich.js / target-linker
 *     assertOtRecordCount) that HALT on a silent under-read.
 *   - OUTAGE (queried==0 AND chunkAttempted>0 AND queryErrorCount>0): some/all of
 *     the attempted chunk errored -> a 3rd-party API is down, not our bug. Return
 *     { degrade: true } so the runner returns a degraded result WITHOUT stamping
 *     or advancing the cursor (chunk stays eligible, retried next run) and F3 can
 *     proceed to the (unrelated) FAERS backfill + F4 publish. NO-SILENT-LOSS is
 *     preserved: nothing is stamped, nothing advances, the loss is loud telemetry.
 *   - NORMAL (queried>0, or nothing eligible): { degrade: false }.
 *
 * Note the outage condition is `queryErrorCount > 0`, NOT `>= chunkAttempted`: a
 * chunk where SOME succeeded would have queried>0 (normal), so reaching queried==0
 * with any error at all means the only outcomes were failures.
 *
 * Keep `eligible` as the first arg for the frozen branch (it is the B2-ceiling
 * denominator the original HALT message reports); chunkAttempted is the SLICE size
 * the runner attempted this run (the outage denominator). PURE: no Date/IO.
 *
 * `queried` here means "compounds the drain actually processed this run", NOT
 * "compounds that got a match" -- a real query that returns zero trials/papers is
 * a legitimate negative result and still counts as progress.
 *
 * @param {number} eligible  eligible compound count at run entry
 * @param {number} queried   compounds genuinely queried (HTTP 200) this run
 * @param {string} label     linker LABEL for the HALT message
 * @param {object} [opts]
 * @param {number} [opts.queryErrorCount=0]  fetch failures this run
 * @param {number} [opts.chunkAttempted=0]   compounds in the attempted slice
 * @returns {{ degrade: boolean }}
 */
export function assertCoverageProgress(eligible, queried, label, { queryErrorCount = 0, chunkAttempted = 0 } = {}) {
    if (queried === 0 && chunkAttempted > 0 && queryErrorCount > 0) {
        return { degrade: true }; // OUTAGE -- non-fatal degrade (do NOT stamp / advance).
    }
    if (eligible > 0 && queried === 0 && queryErrorCount === 0) {
        throw new Error(
            `[${label}] HALT: eligible=${eligible} but queried=0 -- the coverage cursor is frozen/stuck `
            + `(no compound advanced this run). Refusing to exit 0 on a silent coverage ceiling `
            + `(B2 regression, per [[cross_cycle_silent_data_loss]]).`,
        );
    }
    return { degrade: false };
}
