/**
 * V0.5.8 Wave C1-2 Phase 1 — single-identifier compound resolver.
 *
 * Splits the "exact identifier -> canonical entity" semantics out of the
 * fuzzy substring-scoring path that lives in compound-search.ts. Agents
 * holding a precise identifier (CHEMBL25, InChIKey, DrugBank ID, ChEBI,
 * KEGG, UNII, RxCUI) get a deterministic single answer or null — no
 * ranked list, no near-collision risk.
 *
 * Two paths:
 *   Fast: input is a CID-shaped identifier -> parseCompoundId -> done,
 *         no R2 scan. The xrefs endpoint fetches via loadTier1.
 *   Indexed (PR-COMPOUND-GUARD): input is a non-CID identifier -> load ONLY
 *         the per-kind Map from the precomputed xref-index.json.gz projection
 *         and Map.get(normalized). Peak ~one ~130K-entry Map, never the whole
 *         compounds-enriched file (which the FDA preserve-all uncap would grow
 *         past the 128MB isolate budget).
 *   Fallback (F3, deploy transition): when the projection is ABSENT (404,
 *         e.g. between this PR's deploy and the first F4 that publishes it),
 *         fall back to the legacy whole-file scan so the endpoint stays alive.
 */

import { parseCompoundId } from './id-parse';
import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';
import { loadXrefKind, xrefIndexExists, type XrefKind } from './xref-index-loader';

export type IdentifierKind =
    | 'pubchem_cid'
    | 'chembl_id'
    | 'inchi_key'
    | 'unii'
    | 'drugbank_id'
    | 'chebi_id'
    | 'kegg_drug_id'
    | 'rxcui';

export interface ResolvedCompound {
    canonical: string;
    cid: number;
    matched_on: IdentifierKind;
}

interface Classified {
    kind: IdentifierKind;
    normalized: string;
}

export function classifyIdentifier(raw: unknown): Classified | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;

    // pubchem_cid (most common; absorbs canonical + CID: prefix + bare numeric).
    // Note: bare numeric is treated as CID; for RxCUI use the explicit `RXCUI:` prefix.
    let m = s.match(/^(?:sciweon::compound::CID:|CID:)?(\d+)$/i);
    if (m) return { kind: 'pubchem_cid', normalized: m[1] };

    m = s.match(/^(CHEMBL\d+)$/i);
    if (m) return { kind: 'chembl_id', normalized: m[1].toUpperCase() };

    m = s.match(/^([A-Z]{14}-[A-Z]{10}-[A-Z])$/i);
    if (m) return { kind: 'inchi_key', normalized: m[1].toUpperCase() };

    m = s.match(/^UNII:([A-Z0-9]{10})$/i);
    if (m) return { kind: 'unii', normalized: m[1].toUpperCase() };

    m = s.match(/^(DB\d{5})$/i);
    if (m) return { kind: 'drugbank_id', normalized: m[1].toUpperCase() };

    m = s.match(/^CHEBI:(\d+)$/i);
    if (m) return { kind: 'chebi_id', normalized: `CHEBI:${m[1]}` };

    m = s.match(/^(?:KEGG:)?(D\d{5})$/i);
    if (m) return { kind: 'kegg_drug_id', normalized: m[1].toUpperCase() };

    m = s.match(/^RXCUI:(\d+)$/i);
    if (m) return { kind: 'rxcui', normalized: m[1] };

    return null;
}

function matchOnField(compound: Record<string, unknown>, kind: IdentifierKind, normalized: string): boolean {
    const ext = (compound.external_ids as Record<string, unknown> | undefined) ?? {};
    switch (kind) {
        case 'pubchem_cid':   return String(compound.pubchem_cid ?? '') === normalized;
        case 'chembl_id':     return (compound.chembl_id as string | undefined) === normalized;
        case 'inchi_key':     return (compound.inchi_key as string | undefined) === normalized;
        case 'unii':          return (ext.unii as string | undefined) === normalized;
        case 'drugbank_id':   return (ext.drugbank_id as string | undefined) === normalized;
        case 'chebi_id':      return (ext.chebi_id as string | undefined) === normalized;
        case 'kegg_drug_id':  return (ext.kegg_drug_id as string | undefined) === normalized;
        case 'rxcui':         return (ext.rxcui as string | undefined) === normalized;
    }
}

export async function resolveEntity(bucket: R2Bucket, raw: string): Promise<ResolvedCompound | null> {
    const c = classifyIdentifier(raw);
    if (!c) return null;

    // Fast path: CID-shaped input does not need an R2 scan.
    if (c.kind === 'pubchem_cid') {
        const parsed = parseCompoundId(c.normalized);
        if ('error' in parsed) return null;
        return { canonical: parsed.canonical, cid: parsed.cid, matched_on: 'pubchem_cid' };
    }

    // Non-CID path: resolve the latest snapshot date.
    let date: string | undefined;
    try {
        const ptrText = await fetchR2JsonText(bucket, 'snapshots/latest.json');
        date = (JSON.parse(ptrText) as { latest_snapshot_date?: string }).latest_snapshot_date;
    } catch { return null; }
    if (!date) return null;

    // Indexed path: load ONLY the queried kind's Map (bounded memory). The
    // xref-index-loader throws on OOM-guard violations (XREF_MAX_BYTES /
    // MAX_XREF_ENTRIES) — those MUST propagate (LOUD), not be swallowed as a
    // false "unresolvable" 404. xrefIndexExists() distinguishes the absent
    // projection (-> legacy fallback) from a present-but-failing read (-> throw).
    if (await xrefIndexExists(bucket, date)) {
        const map = await loadXrefKind(bucket, date, c.kind as XrefKind);
        const cid = map.get(c.normalized);
        if (typeof cid !== 'number' || !Number.isInteger(cid)) return null;
        return { canonical: `sciweon::compound::CID:${cid}`, cid, matched_on: c.kind };
    }

    // F3 fallback (deploy transition): projection not yet published for this
    // date -> the legacy whole-file scan keeps /xrefs alive until the first F4.
    return resolveByWholeFileScan(bucket, date, c);
}

/**
 * Legacy whole-file scan — the pre-PR-COMPOUND-GUARD path, kept ONLY as the
 * deploy-transition fallback (projection absent). Once the projection is
 * universally published this branch is unreachable; it stays for safety.
 */
async function resolveByWholeFileScan(
    bucket: R2Bucket, date: string, c: Classified,
): Promise<ResolvedCompound | null> {
    let text: string;
    try {
        text = await fetchR2GunzippedText(bucket, `snapshots/${date}/compounds-enriched.jsonl.gz`);
    } catch { return null; }

    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let compound: Record<string, unknown>;
        try { compound = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (matchOnField(compound, c.kind, c.normalized)) {
            const cid = compound.pubchem_cid as number;
            if (typeof cid !== 'number' || !Number.isInteger(cid)) continue;
            return {
                canonical: `sciweon::compound::CID:${cid}`,
                cid,
                matched_on: c.kind,
            };
        }
    }
    return null;
}
