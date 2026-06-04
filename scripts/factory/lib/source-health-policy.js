/**
 * Source Health Policy -- per-source cadence classification.
 *
 * The Source Health Monitor applies a SINGLE staleness window (HEALTHY 36h /
 * STALE 96h) to last_seen age. That window is only meaningful for sources with
 * a DAILY freshness expectation (the F1 daily-cron producers). Manual,
 * by-design-absent, and not-yet-built sources have NO daily expectation, so
 * their STALE/CRITICAL age must NOT trip the monitor's fail-trigger -- doing so
 * is a FALSE POSITIVE (run 26932559226: corpus_add_seed crossed ~48h and tripped
 * `hasStale -> exit 1`, despite being a manual workflow_dispatch seed-add that
 * only runs when the founder adds seeds).
 *
 * This is NOT a blind threshold bump ([[no_shortcut_in_science]]): the global
 * STALE/CRITICAL thresholds are UNCHANGED, so a 'daily' source going stale STILL
 * fails. This is a per-source EXPECTATION config -- each non-'daily' source
 * genuinely has no daily freshness expectation and carries a justification below.
 * The class is shown in the report (auditable; never hidden).
 *
 * Cadence classes:
 *   'daily'        -- DAILY freshness expectation; STALE/CRITICAL MUST fail.
 *   'manual'       -- runs only on founder workflow_dispatch; age does not fail.
 *   'not_ingested' -- by-design NOT directly ingested (layered substitute); age does not fail.
 *   'planned'      -- producer not yet built / produces 0 today; absence does not fail.
 *
 * Default for an UNKNOWN source = 'daily' (fail-loud: a NEW source that goes
 * stale should still alarm -- the safe default, never silent).
 */

export const DEFAULT_CADENCE = 'daily';

// Cadence classes whose STALE/CRITICAL status does NOT contribute to the
// monitor's fail decision (exit 1/2). 'daily' is intentionally excluded.
export const NON_FAILING_CADENCES = Object.freeze([
    'manual', 'not_ingested', 'planned',
]);

export const SOURCE_HEALTH_POLICY = Object.freeze({
    // --- 'daily' : F1 daily-cron producers. STALE/CRITICAL MUST fail. ---
    chembl: 'daily',
    chembl_bioactivity: 'daily',
    clinicaltrials: 'daily',
    ctis: 'daily',
    dailymed: 'daily',
    fda_srs: 'daily',
    open_targets: 'daily',
    openalex: 'daily',
    pubchem: 'daily',
    rxnorm: 'daily',
    s2: 'daily',
    unichem: 'daily',

    // --- 'manual' : founder workflow_dispatch only, no daily expectation. ---
    // corpus_add_seed: injected by lib/corpus-add-inject.js when the founder
    // runs "Factory Seed Corpus Add" (workflow_dispatch only). Its last_seen is
    // the last manual seed-add, which is irregular by design -- a 50h age is
    // normal, not a freshness failure. THIS is the false positive being fixed.
    corpus_add_seed: 'manual',

    // --- 'not_ingested' : by-design NOT directly ingested. ---
    // kegg: layered substitute, not directly ingested per bulk tracker #37.
    // Expected-absent; presence/age is informational, never a failure.
    kegg: 'not_ingested',

    // --- 'planned' : producer not yet built / produces 0 to the snapshot. ---
    // pubchem_bioassay: bioassay ingest not yet built; currently 0 records.
    pubchem_bioassay: 'planned',
    // openfda / openfda_faers: FAERS producer not yet wired to the snapshot.
    openfda: 'planned',
    openfda_faers: 'planned',
    // retraction_watch: retraction feed producer not yet built.
    retraction_watch: 'planned',
    // uniprot: SwissProt ingest in diagnostic stage (PR-UNIPROT-0); not yet producing.
    uniprot: 'planned',
});

/**
 * Cadence class for a source. Unknown sources default to 'daily' (fail-loud).
 * @param {string} source
 * @returns {string} cadence class
 */
export function cadenceFor(source) {
    return SOURCE_HEALTH_POLICY[source] ?? DEFAULT_CADENCE;
}

/**
 * Whether a source's STALE/CRITICAL status contributes to the fail decision.
 * Only 'daily'-cadence sources do. Pure; no Date / no I/O.
 * @param {string} source
 * @returns {boolean}
 */
export function contributesToFail(source) {
    return !NON_FAILING_CADENCES.includes(cadenceFor(source));
}
