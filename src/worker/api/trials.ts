/**
 * GET /api/v1/compound/:id/trials
 * Returns all clinical trials linked to a compound from the latest snapshot.
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { loadTrialsForCompound } from '../lib/trial-loader';

const PATH_RE = /^\/api\/v1\/compound\/([^/]+)\/trials$/;

export async function handleTrials(
    req: Request,
    env: Env,
    _ctx: ExecutionContext,
): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return Response.json(
            { error: 'Method not allowed', allowed: ['GET', 'HEAD'] },
            { status: 405 },
        );
    }

    const url = new URL(req.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) {
        return Response.json({ error: 'Invalid endpoint path' }, { status: 404 });
    }

    const parsed = parseCompoundId(match[1]);
    if ('error' in parsed) {
        return Response.json(
            { error: 'Invalid entity ID format', detail: parsed.error },
            { status: 400 },
        );
    }

    if (!env.SCIWEON_R2) {
        return Response.json(
            { error: 'Data layer not configured', detail: 'R2 binding SCIWEON_R2 is not bound.' },
            { status: 503 },
        );
    }

    const records = await loadTrialsForCompound(env.SCIWEON_R2, parsed.canonical);
    return Response.json(
        { id: parsed.canonical, count: records.length, trials: records },
        {
            status: 200,
            headers: { 'cache-control': 'public, max-age=300, s-maxage=900' },
        },
    );
}
