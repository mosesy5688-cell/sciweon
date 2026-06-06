/**
 * Compound search — substring scan over a COMPACT search projection.
 *
 * PR-COMPOUND-GUARD: reads `compounds-search.jsonl.gz` (built by
 * compound-projection-builder.js) instead of the full compounds-enriched
 * file. The projection carries EXACTLY the union of fields scoreMatch +
 * summarize read (id, pubchem_cid, chembl_id, synonyms[], iupac_name,
 * molecular_formula, molecular_weight.value, drug_status.max_phase,
 * confidence.overall) in their NESTED shapes, so scoreMatch/summarize run
 * BYTE-IDENTICALLY against a projection record. It EXCLUDES fda_signals
 * (unused here) -> the projection is INVARIANT under the FDA preserve-all
 * uncap that would otherwise re-OOM this whole-file reader.
 *
 * Scoring: exact CID/ChEMBL/synonym = 90-100, starts-with = 60-70,
 * contains = 30-50. Caller passes query already lowercased.
 *
 * Fallback (deploy transition): when the projection is ABSENT (404, between
 * this PR's deploy and the first F4 that publishes it) fall back to the full
 * compounds-enriched file so search stays alive.
 */

import { fetchR2GunzippedText, fetchR2JsonText } from './r2-fetch';

const SEARCH_PROJECTION = 'compounds-search.jsonl.gz';
const FULL_ENRICHED = 'compounds-enriched.jsonl.gz';

export interface CompoundSummary {
    id: string;
    pubchem_cid: number;
    chembl_id: string | null;
    name: string;
    iupac_name: string | null;
    molecular_formula: string;
    molecular_weight: number | null;
    drug_status: { max_phase: number | null } | null;
    confidence_overall: number | null;
}

interface SearchHit extends CompoundSummary {
    _score: number;
}

// Exported for the projection round-trip test (compound-projection-builder.test.ts):
// it locks that scoreMatch + summarize run BYTE-IDENTICALLY against a projection
// record vs the full enriched record.
export function scoreMatch(query: string, compound: Record<string, unknown>): number {
    const synonyms = (compound.synonyms as string[] | null) ?? [];
    const iupac = ((compound.iupac_name as string) ?? '').toLowerCase();
    const formula = ((compound.molecular_formula as string) ?? '').toLowerCase();
    const chemblId = ((compound.chembl_id as string) ?? '').toLowerCase();
    const cid = String(compound.pubchem_cid ?? '');

    if (cid === query) return 100;
    if (chemblId === query) return 95;
    for (const s of synonyms) { if (s.toLowerCase() === query) return 90; }
    if (formula === query) return 85;
    for (const s of synonyms) { if (s.toLowerCase().startsWith(query)) return 70; }
    if (iupac.startsWith(query)) return 60;
    for (const s of synonyms) { if (s.toLowerCase().includes(query)) return 50; }
    if (iupac.includes(query)) return 40;
    if (formula.includes(query)) return 30;
    return 0;
}

export function summarize(compound: Record<string, unknown>): CompoundSummary {
    const synonyms = (compound.synonyms as string[] | null) ?? [];
    const name = synonyms[0] ?? (compound.iupac_name as string) ?? String(compound.pubchem_cid ?? '');
    const mwObj = compound.molecular_weight as { value?: number } | null;
    const ds = compound.drug_status as { max_phase?: number | null } | null;
    const conf = compound.confidence as { overall?: number } | null;
    return {
        id: compound.id as string,
        pubchem_cid: compound.pubchem_cid as number,
        chembl_id: (compound.chembl_id as string | null) ?? null,
        name,
        iupac_name: (compound.iupac_name as string | null) ?? null,
        molecular_formula: (compound.molecular_formula as string) ?? '',
        molecular_weight: mwObj?.value ?? null,
        drug_status: ds ? { max_phase: ds.max_phase ?? null } : null,
        confidence_overall: conf?.overall ?? null,
    };
}

export async function searchCompounds(
    bucket: R2Bucket,
    query: string,
    limit: number,
): Promise<CompoundSummary[]> {
    const ptrText = await fetchR2JsonText(bucket, 'snapshots/latest.json');
    const ptr = JSON.parse(ptrText) as { latest_snapshot_date?: string };
    const date = ptr.latest_snapshot_date;
    if (!date) return [];

    const text = await fetchSearchCorpus(bucket, date);
    const hits: SearchHit[] = [];

    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let compound: Record<string, unknown>;
        try { compound = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const score = scoreMatch(query, compound);
        if (score > 0) hits.push({ ...summarize(compound), _score: score });
    }

    hits.sort((a, b) => b._score - a._score);
    return hits.slice(0, limit).map(({ _score: _s, ...rest }) => rest);
}

/**
 * Fetch the compact search projection; on 404 (projection not yet published
 * for this date — deploy transition) fall back to the full enriched file.
 * A head() probe distinguishes "absent" (fall back) from a genuine read
 * failure (propagate as a thrown error rather than mask a corrupt projection).
 */
async function fetchSearchCorpus(bucket: R2Bucket, date: string): Promise<string> {
    const projKey = `snapshots/${date}/${SEARCH_PROJECTION}`;
    const head = await bucket.head(projKey);
    if (head) return fetchR2GunzippedText(bucket, projKey);
    return fetchR2GunzippedText(bucket, `snapshots/${date}/${FULL_ENRICHED}`);
}
