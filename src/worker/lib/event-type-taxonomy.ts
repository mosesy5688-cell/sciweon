/**
 * NegEvidence event_type taxonomy — Worker-side view.
 *
 * The canonical 7-type list lives in `src/lib/schemas/neg-evidence-types.js`
 * (single source of truth shared with the factory builders and the
 * producer-side schema). This module re-exports the list under the
 * Worker-facing name `EVIDENCE_TYPES` and derives the `EvidenceType`
 * literal-union type from the SSoT tuple. The producer-side enforcement
 * (gate REJECT on unknown enum) means a typo can never reach R2; this
 * file is the consumer-side narrowing.
 */

import {
    NEG_EVIDENCE_TYPES,
    isKnownEvidenceType,
} from '../../lib/schemas/neg-evidence-types.js';

export const EVIDENCE_TYPES = NEG_EVIDENCE_TYPES;

export type EvidenceType = typeof NEG_EVIDENCE_TYPES[number];

export { isKnownEvidenceType };

/**
 * Parse a comma-separated client filter (e.g. ?event_type=trial_failure,paper_retraction)
 * into a normalized Set of known types. Unknown tokens are silently dropped
 * (caller can detect via empty Set + non-empty raw input). Trims whitespace,
 * lowercases, caps at 10 tokens to avoid abuse.
 *
 * Returns null when raw is empty/missing — distinguishes "no filter requested"
 * from "filter requested but matched nothing" (empty Set).
 */
export function parseEventTypeFilter(raw: string | null | undefined): Set<EvidenceType> | null {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    const tokens = raw.split(',').slice(0, 10).map(s => s.trim().toLowerCase());
    const out = new Set<EvidenceType>();
    for (const t of tokens) {
        if (isKnownEvidenceType(t)) out.add(t as EvidenceType);
    }
    return out;
}
