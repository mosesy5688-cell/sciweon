/**
 * GET /api/v1/compound/:id/bioactivities
 * Returns all bioactivity records for a compound from the latest snapshot.
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { loadBioactivitiesForCompound } from '../lib/bioactivity-loader';
import { SourceLoadError } from '../lib/source-load-error';

const PATH_RE = /^\/api\/v1\/compound\/([^/]+)\/bioactivities$/;

export async function handleBioactivities(
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

    try {
        const records = await loadBioactivitiesForCompound(env.SCIWEON_R2, parsed.canonical);
        return Response.json(
            { id: parsed.canonical, count: records.length, bioactivities: records },
            {
                status: 200,
                headers: { 'cache-control': 'public, max-age=300, s-maxage=900' },
            },
        );
    } catch (err) {
        // RK-13: a source READ failure is NOT a no-evidence result. Map the typed
        // SourceLoadError to a retryable status (parse_failed -> 502, else 503)
        // carrying the contract carriers, never a 200/count:0.
        if (err instanceof SourceLoadError) {
            return Response.json(
                {
                    error: 'Source unavailable',
                    source: err.source,
                    failure_class: err.failure_class,
                    retryable: err.retryable,
                    detail: 'Upstream source read failed; this is NOT a no-evidence result. Retry shortly.',
                },
                { status: err.failure_class === 'parse_failed' ? 502 : 503 },
            );
        }
        throw err;
    }
}
