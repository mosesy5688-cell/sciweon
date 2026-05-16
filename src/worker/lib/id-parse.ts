/**
 * Entity ID parser — per SCIWEON_DATA_ARCHITECTURE §3.0 (locked 2026-05-17).
 *
 * Accepts canonical full IDs (sciweon::compound::CID:2244), short forms
 * (CID:2244, 2244), and URL-encoded variants. Returns the canonical CID.
 * Refuses anything that does not fit the documented compound ID grammar.
 *
 * Why this lives in its own file: every entity endpoint validates IDs the
 * same way; sharing one parser keeps the regex and error shape consistent
 * (contract tests assert specific error messages).
 */

export interface ParsedCompoundId {
    canonical: string;       // "sciweon::compound::CID:2244"
    cid: number;             // 2244
}

const CANONICAL_PREFIX = 'sciweon::compound::CID:';
const SHORT_PREFIX = 'CID:';

export function parseCompoundId(raw: string): ParsedCompoundId | { error: string } {
    if (typeof raw !== 'string' || raw.length === 0) {
        return { error: 'Compound ID is required' };
    }
    // URL decoding (path segments may percent-encode `::` as %3A%3A)
    let id = raw;
    try {
        id = decodeURIComponent(raw);
    } catch {
        return { error: 'Compound ID is not valid percent-encoded text' };
    }

    let cidPart: string;
    if (id.startsWith(CANONICAL_PREFIX)) {
        cidPart = id.slice(CANONICAL_PREFIX.length);
    } else if (id.startsWith(SHORT_PREFIX)) {
        cidPart = id.slice(SHORT_PREFIX.length);
    } else if (/^\d+$/.test(id)) {
        cidPart = id;
    } else {
        return {
            error: `Invalid compound ID format. Expected sciweon::compound::CID:<n>, CID:<n>, or <n>; got "${id.slice(0, 60)}"`,
        };
    }

    if (!/^\d+$/.test(cidPart)) {
        return { error: `Compound ID numeric part must be digits, got "${cidPart.slice(0, 40)}"` };
    }

    const cid = Number(cidPart);
    if (!Number.isInteger(cid) || cid < 1 || cid > 1e10) {
        return { error: `Compound CID out of range (1 to 10^10), got ${cidPart}` };
    }

    return {
        canonical: `${CANONICAL_PREFIX}${cid}`,
        cid,
    };
}
