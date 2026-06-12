/**
 * MCP tool handlers — extracted from src/worker/api/mcp.ts (cycle 20).
 *
 * Each `handleToolXxx` validates args, calls a loader/aggregator, and
 * returns the MCP `{content: [{type:'text', text: JSON.stringify(...)}]}`
 * envelope. The JSON-RPC layer (mcp.ts) owns method dispatch + error
 * translation; this module owns per-tool semantics.
 *
 * Lives in lib/ rather than api/ so api/mcp.ts stays under the CES
 * Art 5.1 ≤250-line cap as new tools land.
 */

import type { Env } from '../../worker';
import { parseCompoundId } from './id-parse';
import { loadNegEvidenceForCompound, NegShardError } from './neg-evidence-loader';
import { SourceLoadError } from './source-load-error';
import { searchCompounds } from './compound-search';
import { EVIDENCE_TYPES, isKnownEvidenceType, type EvidenceType } from './event-type-taxonomy';
import { resolveEntity } from './entity-resolver';
import { aggregateRepurposingEvidence } from './repurposing-aggregator';
import { parseUniprotId, loadTargetIndex, getTargetEntry } from './target-loader';
import { pickTargetView, type TargetSection } from '../api/target';

export class ToolError extends Error {
    constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

function originOf(req: Request): string {
    try { return new URL(req.url).origin; } catch { return 'https://sciweon.com'; }
}

function requireR2(env: Env): R2Bucket {
    if (!env.SCIWEON_R2) {
        throw new ToolError(-32603, 'Data layer not configured (R2 binding missing)');
    }
    return env.SCIWEON_R2;
}

function requireCid(args: Record<string, unknown>): string {
    const cidArg = args?.cid;
    if (typeof cidArg !== 'string' || cidArg.length === 0) {
        throw new ToolError(-32602, 'Invalid params: cid is required and must be a string');
    }
    const parsed = parseCompoundId(cidArg);
    if ('error' in parsed) {
        throw new ToolError(-32602, `Invalid compound ID: ${parsed.error}`);
    }
    return parsed.canonical;
}

function textContent(payload: unknown): unknown {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export async function handleToolSearch(args: Record<string, unknown>, env: Env): Promise<unknown> {
    const q = args?.query;
    if (typeof q !== 'string' || q.trim().length === 0) {
        throw new ToolError(-32602, 'Invalid params: query is required and must be a non-empty string');
    }
    if (q.trim().length > 200) {
        throw new ToolError(-32602, 'Invalid params: query must be 200 characters or fewer');
    }
    const rawLimit = typeof args.limit === 'number' ? args.limit : 10;
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 25);
    const bucket = requireR2(env);
    const results = await searchCompounds(bucket, q.trim().toLowerCase(), limit);
    return textContent({ query: q.trim(), count: results.length, results });
}

export async function handleToolNegativeEvidence(args: Record<string, unknown>, env: Env, req: Request): Promise<unknown> {
    const canonical = requireCid(args);
    const bucket = requireR2(env);
    let eventTypeFilter: Set<EvidenceType> | null = null;
    if (Array.isArray(args.event_types) && args.event_types.length > 0) {
        eventTypeFilter = new Set<EvidenceType>();
        for (const t of args.event_types) {
            if (!isKnownEvidenceType(t)) {
                throw new ToolError(-32602, `Invalid event_types token: ${JSON.stringify(t)} — must be one of ${EVIDENCE_TYPES.join(', ')}`);
            }
            eventTypeFilter.add(t);
        }
    }
    try {
        const response = await loadNegEvidenceForCompound(bucket, canonical, originOf(req), eventTypeFilter);
        return textContent(response);
    } catch (err) {
        // INVERTED dual-path: a sharded read failure is LOUD (never falls back
        // to the legacy whole-file path). Surface as a retryable service error
        // rather than a generic internal error.
        if (err instanceof NegShardError) {
            throw new ToolError(-32000, 'Negative-evidence service unavailable (sharded read failed); retry shortly');
        }
        throw err;
    }
}

export async function handleToolRepurposingEvidence(args: Record<string, unknown>, env: Env, req: Request): Promise<unknown> {
    const canonical = requireCid(args);
    const bucket = requireR2(env);
    try {
        const response = await aggregateRepurposingEvidence(bucket, canonical, originOf(req));
        return textContent(response);
    } catch (err) {
        // RK-13: a loader source-failure PROPAGATES through the aggregator (never
        // caught-and-emptied) so the verdict is never computed on falsely-empty
        // data. Surface as a retryable service error, never a 'none' verdict.
        if (err instanceof SourceLoadError) {
            throw new ToolError(
                -32000,
                `Repurposing evidence source unavailable (${err.source}: ${err.failure_class}); this is NOT a no-evidence verdict, retry shortly`,
            );
        }
        throw err;
    }
}

export async function handleToolResolveEntity(args: Record<string, unknown>, env: Env): Promise<unknown> {
    const idArg = args?.identifier;
    if (typeof idArg !== 'string' || idArg.length === 0) {
        throw new ToolError(-32602, 'Invalid params: identifier is required and must be a string');
    }
    const bucket = requireR2(env);
    const resolved = await resolveEntity(bucket, idArg);
    const payload = resolved
        ? { resolved: true, canonical_id: resolved.canonical, cid: resolved.cid, matched_on: resolved.matched_on }
        : { resolved: false, query: idArg };
    return textContent(payload);
}

const VALID_TARGET_SECTIONS = new Set<TargetSection>(['drugs', 'trials', 'negative_evidence']);

export async function handleToolGetTargetDrugs(args: Record<string, unknown>, env: Env): Promise<unknown> {
    const idArg = args?.target_id;
    if (typeof idArg !== 'string' || idArg.length === 0) {
        throw new ToolError(-32602, 'Invalid params: target_id is required and must be a string');
    }
    const parsed = parseUniprotId(idArg);
    if (!parsed.ok) {
        throw new ToolError(-32602, `Invalid target_id: ${parsed.error}`);
    }
    let sections: Set<TargetSection> = new Set(['drugs']);
    if (Array.isArray(args.include) && args.include.length > 0) {
        sections = new Set<TargetSection>();
        for (const t of args.include) {
            if (typeof t !== 'string' || !VALID_TARGET_SECTIONS.has(t as TargetSection)) {
                throw new ToolError(-32602, `Invalid include token: ${JSON.stringify(t)} — must be one of drugs, trials, negative_evidence`);
            }
            sections.add(t as TargetSection);
        }
    }
    const bucket = requireR2(env);
    let index;
    try {
        index = await loadTargetIndex(bucket);
    } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (/not found|disappeared|missing/i.test(m)) {
            return textContent({ resolved: false, target_id: parsed.canonical, reason: 'Target index not yet built — next factory-1 cron will produce it.' });
        }
        throw err;
    }
    const entry = getTargetEntry(index, parsed.canonical);
    if (!entry) {
        return textContent({ resolved: false, target_id: parsed.canonical, snapshot_date: index.snapshotDate, reason: 'No bioactivities with this uniprot_accession in current snapshot.' });
    }
    return textContent({ resolved: true, snapshot_date: index.snapshotDate, target: pickTargetView(entry, sections) });
}
