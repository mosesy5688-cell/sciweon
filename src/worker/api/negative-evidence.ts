/**
 * GET /api/v1/compound/:id/negative-evidence — V0.5.2 flagship endpoint.
 *
 * Surfaces the unified NegEvidence Entity (4,328 records as of 2026-05-16)
 * to Agents. Before this endpoint, the NegEvidence synthesis sat in R2
 * invisible to any caller — backbone work without a faucet.
 *
 * Contract per SCIWEON_DATA_ARCHITECTURE §3.0:
 *   200  full negative-evidence response (signals + verdict)
 *   400  malformed compound ID
 *   404  no R2 binding configured OR snapshot pointer missing
 *   500  unexpected server error (never leaks internal architecture)
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { loadNegEvidenceForCompound, NegShardError, DEFAULT_PAGE_LIMIT } from '../lib/neg-evidence-loader';
import { parseEventTypeFilter } from '../lib/event-type-taxonomy';
import { jsonWithRights } from '../lib/source-rights-filter';

function parseIntParam(raw: string | null, fallback: number): number {
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const PATH_RE = /^\/api\/v1\/compound\/([^/]+)\/negative-evidence$/;

export async function handleNegativeEvidence(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return Response.json({ error: 'Method not allowed', allowed: ['GET', 'HEAD'] }, { status: 405 });
    }

    const url = new URL(req.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) {
        return Response.json({ error: 'Invalid endpoint path' }, { status: 404 });
    }
    const idRaw = match[1];
    const parsed = parseCompoundId(idRaw);
    if ('error' in parsed) {
        return Response.json({ error: 'Invalid entity ID format', detail: parsed.error }, { status: 400 });
    }

    if (!env.SCIWEON_R2) {
        return Response.json(
            { error: 'Data layer not configured', detail: 'R2 binding SCIWEON_R2 is not bound to this Worker.' },
            { status: 503 },
        );
    }

    const baseUrl = `${url.protocol}//${url.host}`;
    // V0.5.8 Phase 1: optional `event_type` filter (comma-separated).
    // Null = no filter; empty Set = client passed only unknown tokens → match nothing.
    const eventTypeFilter = parseEventTypeFilter(url.searchParams.get('event_type'));
    // PR-T1.1-LEVER: bounded paginated serving (?offset=&limit=). The stored
    // neg-evidence is complete; the response.pagination block carries the true
    // total + has_more + next_offset so the bound is LOUD + paginable.
    const offset = parseIntParam(url.searchParams.get('offset'), 0);
    const limit = parseIntParam(url.searchParams.get('limit'), DEFAULT_PAGE_LIMIT);
    try {
        const response = await loadNegEvidenceForCompound(
            env.SCIWEON_R2, parsed.canonical, baseUrl, eventTypeFilter, { offset, limit },
        );
        // RC-3A: source-rights containment applied at the serialization
        // boundary (withholds the MedDRA PT + faers-id slug; keeps the signal).
        // x-sciweon-schema-minor bumped 1.1 -> 1.2 as a response-version binding
        // so a cached pre-filter body is distinguishable post-deploy.
        return jsonWithRights(response, {
            status: 200,
            headers: {
                'cache-control': 'public, max-age=300, s-maxage=900',
                'x-sciweon-schema-minor': '1.2',
                'x-sciweon-rights-filter': 'rc3a-v1',
            },
        });
    } catch (err) {
        // INVERTED dual-path: a sharded read failure is LOUD -> 503 (never a
        // silent fall-back to the legacy whole-file path, which would re-OOM or
        // mask a corrupt shard as a false-clean on the safety endpoint).
        if (err instanceof NegShardError) {
            return Response.json(
                { error: 'Negative-evidence service unavailable', detail: 'Sharded read failed; retry shortly.' },
                { status: 503 },
            );
        }
        const message = err instanceof Error ? err.message : String(err);
        if (/Short read|etag drifted|disappeared/i.test(message)) {
            return Response.json(
                { error: 'Data integrity error', detail: 'Upstream object failed integrity validation. Retry shortly.' },
                { status: 502 },
            );
        }
        if (/not found/i.test(message)) {
            return Response.json(
                { error: 'Snapshot not available', detail: 'Latest snapshot pointer or data file missing.' },
                { status: 404 },
            );
        }
        return Response.json(
            { error: 'Internal server error', detail: message.length > 200 ? 'Unexpected upstream failure' : message },
            { status: 500 },
        );
    }
}
