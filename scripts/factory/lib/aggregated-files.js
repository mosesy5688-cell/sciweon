/**
 * AGGREGATED_FILES — single source-of-truth for the aggregated bundle.
 *
 * Both stage-3-aggregate.js (which builds & uploads the bundle) and
 * stage-4-upload.js (which downloads it for the publish step) must agree
 * on this list. Before the SSoT extraction, the lists lived in both
 * scripts and drifted: PR #96 added target-index.json to stage-3 only,
 * F4 silently skipped uploading the file produced by F3 — the exact
 * cross-cycle silent-data-loss pattern that C1-1 Phase 2 addressed for
 * evidence_type. Adding a new aggregated artifact now means editing one
 * file, not two.
 *
 * The frozen array prevents accidental mutation at module scope.
 */

export const AGGREGATED_FILES = Object.freeze([
    'compounds-enriched.jsonl',
    'bioactivities.jsonl',
    'trials.jsonl',
    'trial-links.jsonl',
    'papers.jsonl',
    'paper-links.jsonl',
    'negative-evidence-raw.jsonl',
    'neg-evidence.jsonl',
    'sciweon-search-index.json',
    'target-index.json',
]);
