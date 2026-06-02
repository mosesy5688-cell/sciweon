/**
 * SID-S derivation for the snomed_concept entity class -- the rehydration anchor.
 *
 * MIRRORS scripts/factory/lib/sid-generator.js generateSID_S() EXACTLY:
 *   SID-S = sha256("sciweon:<entity_class>:<canonicalization_version>:<anchor_payload>")
 *           .hex.substring(0, 32)
 * For SNOMED: entity_class = "snomed_concept", canonicalization_version =
 * "snomed.concept.v1.0", anchor_payload = "SNOMEDCT_US:<CODE>" (content-addressed
 * on the SCTID only -- NEVER the mutable preferred string).
 *
 * Ships ZERO SNOMED content: this file contains only the formula constants and
 * NUMERIC SCTIDs (frozen pins). The researcher supplies CODE values from THEIR OWN
 * licensed MRCONSO. The published Sciweon snapshot carries only the resulting hashes
 * ({sid_s, sid_c}); recomputing sidS(code) over a licensed local MRCONSO and
 * hash-matching the published sid_s is the ONLY rehydration path (no CUI anywhere).
 */

import { createHash } from 'node:crypto';

// Pinned to the published snapshot's (entity_class, canonicalization_version).
// A researcher confirms these match the snapshot they downloaded before trusting a join.
export const NAMESPACE = 'sciweon';
export const SNOMED_ENTITY_CLASS = 'snomed_concept';
export const SNOMED_CANON_VERSION = 'snomed.concept.v1.0';
export const SNOMED_SAB = 'SNOMEDCT_US';
export const SID_LENGTH = 32; // 128-bit hex truncation, matches sid-generator.js

/**
 * Build the content-addressed anchor payload for a SNOMED concept code.
 * Mirrors umls-concept-streams.js toConceptRecord: `<SAB>:<CODE>`.
 * @param {string} code  the SNOMED CT US concept code (SCTID) from MRCONSO.CODE
 * @returns {string} "SNOMEDCT_US:<code>"
 */
export function snomedAnchorPayload(code) {
    if (typeof code !== 'string' || code.length === 0) {
        throw new Error('[sid-derive] code must be a non-empty string');
    }
    return `${SNOMED_SAB}:${code}`;
}

/**
 * Derive the Sciweon SID-S for a SNOMED CT US concept code.
 * Byte-identical to generateSID_S('snomed_concept', 'SNOMEDCT_US:<code>',
 * 'snomed.concept.v1.0') in scripts/factory/lib/sid-generator.js.
 *
 * @param {string} code  the SCTID (MRCONSO.CODE for SAB=SNOMEDCT_US rows)
 * @returns {string} 32-char hex SID-S
 */
export function sidS(code) {
    const anchorPayload = snomedAnchorPayload(code);
    const canonicalString =
        `${NAMESPACE}:${SNOMED_ENTITY_CLASS}:${SNOMED_CANON_VERSION}:${anchorPayload}`;
    return createHash('sha256').update(canonicalString).digest('hex').substring(0, SID_LENGTH);
}

/**
 * Frozen SID-S reference pins (NUMERIC SCTIDs only -- NO SNOMED strings here).
 * Copied verbatim from scripts/factory/lib/sid-snomed-stamping.js so a drift in the
 * derivation formula breaks the tool test. `99999001` is the synthetic test SCTID.
 */
export const FROZEN_SID_S_PINS = Object.freeze({
    '73211009': 'a409595b11d0aabe31aecd559a84e04a',
    '38341003': 'b42be5e83138ee10246972aba4ec248d',
    '22298006': '9bf38a9717b0f8cb09f59abb378948b8',
    '195967001': '41b646fc894d0240ae2736c9f0a885eb',
    '99999001': '09f49d1dcdc362886b5c8f6f8e78ac08',
});
