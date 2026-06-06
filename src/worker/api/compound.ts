/**
 * GET /api/v1/compound/:id — V0.6 B.4 dual-tier compound endpoint.
 *
 * Returns full enriched compound data (Tier 1) or PubChem stub (Tier 2).
 * _tier field in response body indicates which tier served the result.
 * Tier 2 compounds include only structural basics (no bioactivity / no trials).
 *
 * R2 (PR-T1.1a serving note): the FDA preserve-all uncap GROWS fda_signals on
 * the compound record (boxed_warnings[], full FAERS terms, etc.). /compound
 * serves that grown record via the BOUNDED per-record RANGE-READ in loadTier1
 * (compound-loader.ts loadTier1Sharded -> fetchR2RangeBytes reads exactly
 * entry.size, one record). The 5a compound-guard projections cover only the
 * search / resolve doors; the publish-time bounds (10MB shard / 64MB record)
 * are the serving guard, so a fat fda_signals record never OOMs the isolate.
 */

import type { Env } from '../../worker';
import { parseCompoundId } from '../lib/id-parse';
import { loadTier1, loadTier2 } from '../lib/compound-loader';

const COMPOUND_PATH_RE = /^\/api\/v1\/compound\/([^/]+)$/;

export async function handleCompound(
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
    const match = COMPOUND_PATH_RE.exec(url.pathname);
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

    const { cid, canonical } = parsed;

    const tier1 = await loadTier1(env, cid);
    if (tier1) {
        return Response.json(
            { id: canonical, compound: { ...tier1, _tier: 'T1' } },
            {
                status: 200,
                headers: { 'cache-control': 'public, max-age=300, s-maxage=900' },
            },
        );
    }

    const tier2 = await loadTier2(env.SCIWEON_R2, cid);
    if (tier2) {
        return Response.json(
            { id: canonical, compound: { ...tier2, _tier: 'T2' } },
            {
                status: 200,
                // Tier 2 is immutable bulk data — safe to cache longer.
                headers: { 'cache-control': 'public, max-age=3600, s-maxage=86400' },
            },
        );
    }

    return Response.json({ error: 'Compound not found', id: canonical }, { status: 404 });
}
