/**
 * GET /api/v1/compound/:id/negative-evidence — V0.5.2 flagship endpoint.
 *
 * Surfaces the unified NegEvidence Entity (4,328 records as of 2026-05-16)
 * to Agents. Before this endpoint, the NegEvidence synthesis sat in R2
 * invisible to any caller — backbone work without a faucet.
 *
 * Contract per SCIWEON_DATA_ARCHITECTURE §3.0:
 *   200  negative-evidence response (signals + evidence-use boundary; no verdict)
 *   400  malformed compound ID
 *   404  snapshot pointer or data file could not be read
 *   500  unexpected server error
 *   502  upstream object could not be read intact
 *   503  no R2 binding configured, OR a sharded read failed
 *
 * Every failure body above carries failure_class + retryable. HTTP status is
 * NOT a retryability signal here: `retryable` is the only retry carrier.
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { loadNegEvidenceForCompound, DEFAULT_PAGE_LIMIT } from '../lib/neg-evidence-loader';
import { NegShardError } from '../lib/neg-shard-error';
import { R2ReadError } from '../lib/r2-fetch';
import { SnapshotContractError } from '../lib/snapshot-context';
import { classifyThrown, failureBody } from '../lib/failure-contract';
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
            failureBody('Data layer not configured', 'data_layer_unconfigured',
                'R2 binding SCIWEON_R2 is not bound to this Worker.'),
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
                'x-sciweon-rights-filter': 'rc3a-v2',
            },
        });
    } catch (err) {
        // INVERTED dual-path: a sharded read failure is LOUD -> 503 (never a
        // silent fall-back to the legacy whole-file path, which would re-OOM or
        // mask a corrupt shard as a false-clean on the safety endpoint).
        if (err instanceof NegShardError) {
            // Both shard classes keep 503; only the carriers distinguish them.
            return Response.json(
                failureBody('Negative-evidence service unavailable', err.failure_class),
                { status: 503 },
            );
        }
        // Observer census: this route had NO typed branch, so a contract
        // violation reached the residual and was classified as unexpected.
        // 6e freezes the status it already had (500); only the class is fixed.
        if (err instanceof SnapshotContractError) {
            return Response.json(
                failureBody('Internal server error', 'snapshot_contract'),
                { status: 500 },
            );
        }
        // Rule 4c.1: dispatch on the throw site's structural discriminant.
        if (err instanceof R2ReadError) {
            if (err.discriminant === 'short_read' || err.discriminant === 'etag_drift'
                || err.discriminant === 'disappeared') {
                return Response.json(
                    failureBody('Data integrity error', 'source_unavailable',
                        'An upstream object could not be read intact. This is a READ failure and NOT a finding that no negative evidence exists.'),
                    { status: 502 },
                );
            }
            if (err.discriminant === 'not_found') {
                // Separately ruled: this 404 KEEPS its status and gains carriers.
                return Response.json(
                    failureBody('Snapshot not available', 'source_unavailable',
                        'The latest snapshot pointer or data file could not be read. This is a READ failure and NOT a finding that no negative evidence exists.'),
                    { status: 404 },
                );
            }
        }
        // Residual: the underlying message is NEVER echoed into a public body.
        return Response.json(
            failureBody('Internal server error', classifyThrown(err)),
            { status: 500 },
        );
    }
}
