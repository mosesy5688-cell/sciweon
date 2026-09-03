/**
 * GET /api/v1/compound/:id/repurposing-evidence — V0.5.8 Wave C1-3 Phase 1.
 *
 * Fuses 3 evidence layers (positive trials + bioactivities, negative
 * NegEvidence signals, retracted papers) in one call. Replaces the
 * 4-endpoint stitching today agents must do manually. Emits NO synthesized
 * verdict -- the layers are returned side by side and the consumer
 * adjudicates.
 *
 * Contract per SCIWEON_DATA_ARCHITECTURE §3.0:
 *   200  three-layer evidence bundle
 *   400  malformed compound ID
 *   404  invalid path
 *   405  non-GET method
 *   503  R2 binding missing
 *   502  upstream object could not be read intact, or could not be decoded
 *   500  unexpected
 *
 * Every failure body above carries failure_class + retryable. HTTP status is
 * NOT a retryability signal here: `retryable` is the only retry carrier.
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { aggregateRepurposingEvidence } from '../lib/repurposing-aggregator';
import { SourceLoadError } from '../lib/source-load-error';
import { SnapshotContractError } from '../lib/snapshot-context';
import { R2ReadError } from '../lib/r2-fetch';
import { classifyThrown, failureBody } from '../lib/failure-contract';
import { jsonWithRights } from '../lib/source-rights-filter';

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
            failureBody('Data layer not configured', 'data_layer_unconfigured',
                'R2 binding SCIWEON_R2 is not bound to this Worker.'),
            { status: 503 },
        );
    }

    const baseUrl = `${url.protocol}//${url.host}`;
    try {
        const response = await aggregateRepurposingEvidence(env.SCIWEON_R2, parsed.canonical, baseUrl);
        // RC-3A: composed-route serialization boundary. negative.examples[].id
        // may be a faers NegEvidence id whose slug encodes a MedDRA PT; the
        // shared filter neutralizes it (the fused bundle is unaffected).
        return jsonWithRights(response, {
            status: 200,
            headers: {
                'cache-control': 'public, max-age=300, s-maxage=900',
                'x-sciweon-schema-minor': '1.0',
                'x-sciweon-rights-filter': 'rc3a-v1',
            },
        });
    } catch (err) {
        // RK-13: a loader source-failure PROPAGATES through the aggregator (it is
        // NOT caught-and-emptied) so the summary is never computed on falsely-empty
        // data. Map it to a retryable status (parse_failed -> 502, else 503), never
        // a falsely-empty result at 200.
        if (err instanceof SourceLoadError) {
            return Response.json(
                {
                    source: err.source,
                    ...failureBody('Source unavailable', err.failure_class,
                        'An upstream evidence source read failed. This is a SOURCE FAILURE and NOT a finding that no evidence exists.'),
                },
                { status: err.failure_class === 'parse_failed' ? 502 : 503 },
            );
        }
        // Observer census: SnapshotContractError is rethrown by the aggregator
        // and had no typed branch here. 6e freezes the status it already had.
        if (err instanceof SnapshotContractError) {
            return Response.json(
                failureBody('Internal server error', 'snapshot_contract'),
                { status: 500 },
            );
        }
        // Rule 4c.1: dispatch on the throw site's structural discriminant.
        if (err instanceof R2ReadError
            && (err.discriminant === 'short_read' || err.discriminant === 'etag_drift'
                || err.discriminant === 'disappeared')) {
            return Response.json(
                failureBody('Data integrity error', 'source_unavailable',
                    'An upstream object could not be read intact. This is a READ failure and NOT a finding that no evidence exists.'),
                { status: 502 },
            );
        }
        // Residual: the underlying message is NEVER echoed into a public body.
        return Response.json(
            failureBody('Internal server error', classifyThrown(err)),
            { status: 500 },
        );
    }
}
