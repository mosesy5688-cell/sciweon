/**
 * V0.5.8 Wave C1-1 Phase 1 — NegEvidence event_type taxonomy.
 *
 * The 7 canonical evidence types Sciweon currently records. Producers
 * (scripts/factory/neg-evidence-builder.js and friends) emit these
 * strings; consumers (Worker API, MCP tool) narrow to this union for
 * runtime validation + TypeScript exhaustiveness checking.
 *
 * Phase 2 (deferred) migrates the producer to import + enforce this
 * taxonomy at emission, eliminating the silent-typo failure mode.
 */

export const EVIDENCE_TYPES = [
    'trial_failure',
    'inactive_bioassay',
    'drug_withdrawal',
    'black_box_warning',
    'faers_adr_signal',
    'serious_adverse_event_per_trial',
    'paper_retraction',
] as const;

export type EvidenceType = typeof EVIDENCE_TYPES[number];

const EVIDENCE_TYPE_SET: Set<string> = new Set(EVIDENCE_TYPES);

export function isKnownEvidenceType(s: unknown): s is EvidenceType {
    return typeof s === 'string' && EVIDENCE_TYPE_SET.has(s);
}

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
        if (isKnownEvidenceType(t)) out.add(t);
    }
    return out;
}
