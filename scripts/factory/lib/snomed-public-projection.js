/**
 * SNOMED Public Projection -- PR-UMLS-3 COMPLIANCE CORE (RULING 1, founder
 * NON-NEGOTIABLE). PR-UMLS-2a retrofit: this is now a THIN wrapper over the shared
 * SSoT projectUmlsPublic('SNOMED', record) (lib/umls-public-projection.js) so the
 * SNOMED rule and the MeSH/LOINC cui-withhold rule live in ONE place and cannot drift.
 * Behavior is UNCHANGED: still EXACTLY { sid_s, sid_c } per concept.
 *
 * projectSnomedPublic(concept) returns a NEW object containing EXACTLY two keys:
 * `{ sid_s, sid_c }`. This is a strict ALLOWLIST, not a denylist -- the output object
 * is CONSTRUCTED fresh from only the two whitelisted fields, so the SNOMED-proprietary
 * payload (preferred_str / STR / raw CODE / CUI / tty / sab / synonyms / anchor_payload)
 * is ANNIHILATED by construction. A future field added to the internal concept record
 * CANNOT leak into the public artifact unless this allowlist is explicitly widened --
 * the compliance test pins the exact 2-key shape so any widening is caught in CI.
 *
 * "Born-Clean": the public snomed-concepts payload exposes ZERO NLM/SNOMED structural
 * content. Even the CUI (a UMLS structural identifier) is withheld -- the researcher's
 * bridge is a LOCAL re-derive (recompute sid_s from their OWN licensed MRCONSO codes +
 * hash-match against the published sid_s), so no CUI is needed in public. See
 * docs/SNOMED_REHYDRATION.md.
 *
 * sid_s + sid_c are Sciweon-original, content-addressed hashes (Sciweon-produced
 * provenance), redistribution-SAFE by the founder's verbatim Appendix-2 review.
 */

import { projectUmlsPublic, SNOMED_PUBLIC_KEYS } from './umls-public-projection.js';

// The ONLY keys permitted into the public SNOMED concept artifact. Widening this
// list is a constitutional change (RULING 1) -- the compliance test fails on any
// extra key, forcing a deliberate, audited edit. Re-exported from the shared SSoT so
// there is a single source for "what SNOMED public allows".
export const SNOMED_PUBLIC_ALLOWLIST = SNOMED_PUBLIC_KEYS;

/**
 * Project one stamped (internal, full) SNOMED concept down to its public shape.
 *
 * Thin delegation to projectUmlsPublic('SNOMED', concept) -- pure, never mutates the
 * input, reads ONLY the two allowlisted fields. A concept missing sid_s/sid_c yields
 * that key as `undefined` (the caller / stamper invariant guarantees both are present
 * post-stamp; the projection itself never invents a value, never copies any other field).
 *
 * @param {object} concept  a stamped internal SNOMED concept record
 * @returns {{ sid_s: string, sid_c: string }}  EXACTLY two keys, nothing else
 */
export function projectSnomedPublic(concept) {
    return projectUmlsPublic('SNOMED', concept);
}
