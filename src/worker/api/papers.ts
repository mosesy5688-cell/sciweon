/**
 * GET /api/v1/compound/:id/papers
 * Returns all papers mentioning a compound from the latest snapshot.
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { loadPapersForCompound } from '../lib/paper-loader';
import { SourceLoadError } from '../lib/source-load-error';
import { loadSnapshotContext, SnapshotContractError } from '../lib/snapshot-context';
import { fetchR2JsonText } from '../lib/r2-fetch';

const PATH_RE = /^\/api\/v1\/compound\/([^/]+)\/papers$/;

export async function handlePapers(
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
        // RK-15 PR-A2: read snapshots/latest.json EXACTLY ONCE per request ->
        // ONE pinned SnapshotContext threaded into the loader (which no longer
        // reads the pointer). A SnapshotContractError fails LOUD (integrity 502),
        // never a degraded 404/empty.
        const ctx = await loadSnapshotContext(k => fetchR2JsonText(env.SCIWEON_R2!, k));
        const records = await loadPapersForCompound(env.SCIWEON_R2, ctx, parsed.canonical);
        return Response.json(
            { id: parsed.canonical, count: records.length, papers: records },
            {
                status: 200,
                headers: { 'cache-control': 'public, max-age=300, s-maxage=900' },
            },
        );
    } catch (err) {
        // RK-15 PR-A2: a latest.json contract violation is an integrity failure
        // (LOUD), never a no-evidence 404/200. Map it to a retryable 502.
        if (err instanceof SnapshotContractError) {
            return Response.json(
                { error: 'Data integrity error', detail: 'snapshots/latest.json failed contract validation. Retry shortly.' },
                { status: 502 },
            );
        }
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
