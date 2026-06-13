/**
 * Target index loader — reads the C2-3 inverse-pivot index from R2.
 *
 * Snapshot location (per scripts/factory/stage-3-aggregate.js + uploader):
 *   snapshots/latest.json         → { latest_snapshot_date: "YYYY-MM-DD" }
 *   snapshots/<date>/target-index.json
 *
 * RK-15 PR-A2: the caller reads snapshots/latest.json EXACTLY ONCE (via
 * loadSnapshotContext) and threads the pinned SnapshotContext in; this loader
 * NO LONGER reads latest.json. The object key is derived UNIFORMLY from
 * ctx.object_prefix (v1: snapshots/<date>/; v2: the declared prefix).
 *
 * Caching: snapshots are immutable once published. `fetchR2Object` caches by
 * (key, etag) per isolate; first call per day downloads + parses, subsequent
 * calls within the same isolate are a Map lookup.
 *
 * UniProt validation regex mirrors BIOACTIVITY_SCHEMA.target.uniprot_accession
 * (src/lib/schemas/bioactivity.js:34) — the producer and consumer share the
 * exact same acceptance pattern.
 */

import { fetchR2GunzippedText } from './r2-fetch';
import { type SnapshotContext } from './snapshot-context';

// snapshot-builder.js gzips every published file; uploader stores the .gz
// blob at the .gz key. Pre-#100 the loader fetched the un-gzipped name,
// which always 404'd in production even when stage-3 produced the file.
const TARGET_INDEX_FILENAME = 'target-index.json.gz';

const UNIPROT_RE = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

export interface ParsedUniprotId {
    ok: true;
    canonical: string;
}

export interface ParsedUniprotError {
    ok: false;
    error: string;
}

export function parseUniprotId(raw: string): ParsedUniprotId | ParsedUniprotError {
    if (typeof raw !== 'string' || raw.length === 0) {
        return { ok: false, error: 'UniProt accession is required' };
    }
    let id = raw;
    try { id = decodeURIComponent(raw); } catch {
        return { ok: false, error: 'UniProt accession is not valid percent-encoded text' };
    }
    const upper = id.toUpperCase();
    if (!UNIPROT_RE.test(upper)) {
        return { ok: false, error: `Invalid UniProt accession format: "${id.slice(0, 40)}"` };
    }
    return { ok: true, canonical: upper };
}

export interface TargetEntry {
    uniprot_accession: string;
    protein_name: string | null;
    gene_symbol: string | null;
    chembl_target_id: string | null;
    organism: { taxon_id: number | null; scientific_name: string | null };
    compound_ids: string[];
    bioactivity_ids: string[];
    trial_ids: string[];
    negative_evidence_ids: string[];
}

interface RawIndex {
    version?: string;
    built_at?: string;
    targets?: Record<string, TargetEntry>;
}

export interface TargetIndex {
    version: string;
    built_at: string;
    snapshotDate: string;
    targets: Record<string, TargetEntry>;
}

export async function loadTargetIndex(bucket: R2Bucket, ctx: SnapshotContext): Promise<TargetIndex> {
    const text = await fetchR2GunzippedText(bucket, `${ctx.object_prefix}${TARGET_INDEX_FILENAME}`);
    const raw = JSON.parse(text) as RawIndex;
    return {
        version: raw.version ?? 'unknown',
        built_at: raw.built_at ?? '',
        snapshotDate: ctx.snapshot_date,
        targets: raw.targets ?? {},
    };
}

export function getTargetEntry(index: TargetIndex, uniprot: string): TargetEntry | null {
    return index.targets[uniprot] ?? null;
}
