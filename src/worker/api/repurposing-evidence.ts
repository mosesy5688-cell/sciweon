/**
 * GET /api/v1/compound/:id/repurposing-evidence — V0.5.8 Wave C1-3 Phase 1.
 *
 * Fuses 3 evidence layers (positive trials + bioactivities, negative
 * NegEvidence signals, retracted papers) in one call and synthesizes a
 * repurposing_signal verdict. Replaces the 4-endpoint stitching today
 * agents must do manually.
 *
 * Contract per SCIWEON_DATA_ARCHITECTURE §3.0:
 *   200  full repurposing assessment
 *   400  malformed compound ID
 *   404  invalid path
 *   405  non-GET method
 *   503  R2 binding missing
 *   502  data integrity error (upstream object missing / etag drift)
 *   500  unexpected
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { aggregateRepurposingEvidence } from '../lib/repurposing-aggregator';
import { SourceLoadError } from '../lib/source-load-error';

const PATH_RE = /^\/api\/v1\/compound\/([^/]+)\/repurposing-evidence$/;

export async function handleRepurposingEvidence(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return Response.json({ error: 'Method not allowed', allowed: ['GET', 'HEAD'] }, { status: 405 });
    }

    const url = new URL(req.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) return Response.json({ error: 'Invalid endpoint path' }, { status: 404 });

    const parsed = parseCompoundId(match[1]);
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
        const response = await aggregateRepurposingEvidence(env.SCIWEON_R2, parsed.canonical, baseUrl);
        return Response.json(response, {
            status: 200,
            headers: {
                'cache-control': 'public, max-age=300, s-maxage=900',
                'x-sciweon-schema-minor': '1.0',
            },
        });
    } catch (err) {
        // RK-13: a loader source-failure PROPAGATES through the aggregator (it is
        // NOT caught-and-emptied) so the verdict is never computed on falsely-empty
        // data. Map it to a retryable status (parse_failed -> 502, else 503), never
        // a 'none' verdict at 200.
        if (err instanceof SourceLoadError) {
            return Response.json(
                {
                    error: 'Source unavailable',
                    source: err.source,
                    failure_class: err.failure_class,
                    retryable: err.retryable,
                    detail: 'An upstream evidence source read failed; this is NOT a no-evidence verdict. Retry shortly.',
                },
                { status: err.failure_class === 'parse_failed' ? 502 : 503 },
            );
        }
        const message = err instanceof Error ? err.message : String(err);
        if (/Short read|etag drifted|disappeared/i.test(message)) {
            return Response.json(
                { error: 'Data integrity error', detail: 'Upstream object failed integrity validation. Retry shortly.' },
                { status: 502 },
            );
        }
        return Response.json(
            { error: 'Internal server error', detail: message.length > 200 ? 'Unexpected upstream failure' : message },
            { status: 500 },
        );
    }
}
