/**
 * Shared hardened JSONL IO -- PR-HARDEN-1 (generalizes the PR-UMLS-4b LOINC fix).
 *
 * THE BUG THIS KILLS (no-silent-data-loss invariant per [[cross_cycle_silent_data_loss]]):
 * the factory enrichers historically defined a local
 *   `async function loadJsonl(file) { try { ...readFile + JSON.parse... } catch { return []; } }`
 * The bare `catch { return []; }` swallowed EVERY error -- including a JSON.parse on a single
 * malformed line. For files that are OVERWRITTEN IN PLACE (trials / diseases / papers /
 * compounds-enriched / bioactivities), that meant: one corrupt line -> loadJsonl returns [] ->
 * writeJsonl(samePath, []) TRUNCATES a real populated file to empty -> silent total data loss.
 *
 * THE FIX (deeper-altitude, so the bug cannot be re-cloned per enricher):
 *   loadJsonlStrict reads the file inside a try whose catch is ENOENT-ONLY -- an absent file is the
 *   ONLY legitimate empty ([] is correct; a brand-new in-place target is created empty, nothing
 *   lost). Any OTHER read error (perms / EIO / etc.) is RE-THROWN. Parsing happens OUTSIDE the
 *   catch, so a malformed line THROWS (never swallowed) and the caller HALTs loud instead of
 *   truncating. This reproduces each legacy caller's line semantics BYTE-IDENTICALLY on valid
 *   input: split('\n') -> filter(Boolean) -> (optional '#' comment filter) -> JSON.parse per line.
 *
 * assertLoaded is the belt-and-suspenders non-empty guard for in-place-overwritten targets that
 * are known to be populated upstream: 0 records there is an anomaly, so refuse to write [] over an
 * existing file. (Cold-start-empty sources -- e.g. the compound master before first ingest -- do
 * NOT get this guard; that question is deferred to a Tier-2 follow-up. The loadJsonlStrict swap
 * alone already prevents truncation for them: a corrupt populated file throws; an absent file
 * ENOENT->[] legitimately writes/creates empty.)
 *
 * DETERMINISM (GEMINI.md Sec 7): no Date.now() / Math.random(); identical input -> identical output.
 */

import fs from 'fs/promises';

/**
 * Load a JSONL file into an array of parsed records, hardened against silent truncation.
 *
 * Contract:
 *   - File ABSENT (ENOENT) -> resolves [] (a legitimately empty / not-yet-created target).
 *   - Any OTHER read error (perms / EIO / EISDIR / ...) -> RE-THROWS (HALT loud, never a silent []).
 *   - A present but MALFORMED line -> JSON.parse THROWS (outside the read catch) -> HALT loud.
 *
 * Byte-identical to the legacy loadJsonl line semantics on valid input:
 *   split('\n') -> filter(Boolean) -> [skipComments? drop lines starting with '#'] -> JSON.parse.
 *
 * @param {string} file - path to the .jsonl file.
 * @param {{ skipComments?: boolean }} [opts] - skipComments:true drops lines starting with '#'
 *   (matches callers whose legacy loadJsonl had `.filter(l => !l.startsWith('#'))`). Default false.
 * @returns {Promise<object[]>}
 */
export async function loadJsonlStrict(file, { skipComments = false } = {}) {
    let content;
    try {
        content = await fs.readFile(file, 'utf-8');
    } catch (err) {
        // ENOENT (file absent) is the ONLY legitimate empty -> []. Everything else is an anomaly
        // (perms / IO / a directory) and MUST re-throw so we never silently overwrite with [].
        if (err && err.code === 'ENOENT') return [];
        throw err;
    }
    // Parse OUTSIDE the catch: a malformed line THROWS here and is never swallowed.
    let lines = content.split('\n').filter(Boolean);
    if (skipComments) lines = lines.filter(l => !l.startsWith('#'));
    return lines.map(l => JSON.parse(l));
}

/**
 * Non-empty guard for in-place-overwritten targets known to be populated upstream. Throws loud if
 * `records` is not a non-empty array, so main() refuses to writeJsonl([]) over an existing file
 * (no silent data loss). Call AFTER the load(s), BEFORE any writeJsonl.
 *
 * @param {unknown} records - the loaded record array.
 * @param {string} label - the enricher LABEL for the HALT message.
 * @param {string} file - the source path for the HALT message.
 */
export function assertLoaded(records, label, file) {
    if (!Array.isArray(records) || records.length === 0) {
        throw new Error(`[${label}] HALT: 0 records loaded from ${file} -- refusing to overwrite it with empty content (no silent data loss)`);
    }
}
