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
import { loadNegEvidenceForCompound } from '../lib/neg-evidence-loader';

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
    try {
        const response = await loadNegEvidenceForCompound(env.SCIWEON_R2, parsed.canonical, baseUrl);
        return Response.json(response, {
            status: 200,
            headers: {
                'cache-control': 'public, max-age=300, s-maxage=900',
                'x-sciweon-schema-minor': '1.0',
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Map known operational errors to the right status without leaking key paths.
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
