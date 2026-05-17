/**
 * Sciweon Worker entry (V0.5.2 — API surface bootstrap).
 *
 * Cloudflare Workers Static Assets pattern: this Worker handles `/api/*`
 * requests; everything else falls through to env.ASSETS (the static Astro
 * build at ./dist). Adding API endpoints does NOT change the existing
 * landing-page behavior.
 *
 * Routing table (V0.5.2 flagship — single endpoint):
 *   GET /api/v1/compound/:id/negative-evidence
 *     → JSON list of NegEvidence records keyed to that compound
 *
 * Future routes (Phase 2):
 *   GET /api/v1/entity/:id
 *   GET /api/v1/search?q=&type=
 *
 * Error contract (per SCIWEON_DATA_ARCHITECTURE §3.0):
 *   400 — malformed entity ID
 *   404 — entity / compound not found
 *   429 — rate limited (not implemented yet; reserved)
 *   500 — server error (must never leak internal architecture)
 */

import { handleNegativeEvidence } from './worker/api/negative-evidence';
import { handleMcp } from './worker/api/mcp';

export interface Env {
    ASSETS: Fetcher;
    SCIWEON_R2?: R2Bucket;
}

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);

        if (url.pathname.startsWith('/api/v1/compound/') && url.pathname.endsWith('/negative-evidence')) {
            try {
                return await handleNegativeEvidence(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (url.pathname === '/api/mcp' || url.pathname === '/api/v1/mcp') {
            try {
                return await handleMcp(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (url.pathname === '/api/v1/_health') {
            return Response.json({
                status: 'ok',
                version: 'V0.5.2',
                r2_binding: !!env.SCIWEON_R2,
                timestamp: new Date().toISOString(),
            });
        }

        return env.ASSETS.fetch(req);
    },
} satisfies ExportedHandler<Env>;

function json500(err: unknown): Response {
    const message = err instanceof Error ? err.message : String(err);
    // Sanitize: never expose R2 keys, paths, internal state.
    const safe = message.length > 200 ? 'Internal server error' : message;
    return Response.json({ error: 'Internal server error', detail: safe }, { status: 500 });
}
