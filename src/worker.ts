/**
 * Sciweon Worker entry (V0.5.5 — bioactivity/trial/paper endpoints).
 *
 * Cloudflare Workers Static Assets pattern: this Worker handles `/api/*`
 * requests; everything else falls through to env.ASSETS (the static Astro
 * build at ./dist). Adding API endpoints does NOT change the existing
 * landing-page behavior.
 *
 * Routing table:
 *   GET /api/v1/compound/:id                    → dual-tier compound lookup (T1/T2)
 *   GET /api/v1/compound/:id/negative-evidence  → NegEvidence signals
 *   GET /api/v1/compound/:id/bioactivities      → bioactivity records
 *   GET /api/v1/compound/:id/trials             → clinical trials
 *   GET /api/v1/compound/:id/papers             → papers mentioning compound
 *   GET /api/v1/target/:uniprot{,/drugs,/trials,/negative-evidence}
 *                                               → C2-3 inverse pivot (V0.6)
 *   POST /api/mcp                               → MCP JSON-RPC 2.0 (V0.5.4)
 *
 * Error contract (per SCIWEON_DATA_ARCHITECTURE §3.0):
 *   400 — malformed entity ID
 *   404 — entity / compound not found
 *   429 — rate limited (not implemented yet; reserved)
 *   500 — server error (must never leak internal architecture)
 */

import { handleNegativeEvidence } from './worker/api/negative-evidence';
import { handleMcp } from './worker/api/mcp';
import { handleCompound } from './worker/api/compound';
import { handleBioactivities } from './worker/api/bioactivities';
import { handleTrials } from './worker/api/trials';
import { handlePapers } from './worker/api/papers';
import { handleXrefs } from './worker/api/xrefs';
import { handleRepurposingEvidence } from './worker/api/repurposing-evidence';
import { handleTarget } from './worker/api/target';

export interface Env {
    ASSETS: Fetcher;
    SCIWEON_R2?: R2Bucket;
    // I-7a Phase 1 optional: enables AES-CTR shard decryption if set.
    // Phase 1 ships without encryption (shard-crypto.js stub returns null);
    // worker decoder uses no-op passthrough when this is unset (Gemini #2).
    SHARD_AES_KEY?: string;
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

        if (url.pathname.startsWith('/api/v1/compound/') && url.pathname.endsWith('/repurposing-evidence')) {
            try {
                return await handleRepurposingEvidence(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (url.pathname.startsWith('/api/v1/compound/') && url.pathname.endsWith('/bioactivities')) {
            try {
                return await handleBioactivities(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (url.pathname.startsWith('/api/v1/compound/') && url.pathname.endsWith('/trials')) {
            try {
                return await handleTrials(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (url.pathname.startsWith('/api/v1/compound/') && url.pathname.endsWith('/papers')) {
            try {
                return await handlePapers(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (/^\/api\/v1\/compound\/[^/]+$/.test(url.pathname)) {
            try {
                return await handleCompound(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (/^\/api\/v1\/target\/[^/]+(?:\/(?:drugs|trials|negative-evidence))?$/.test(url.pathname)) {
            try {
                return await handleTarget(req, env, ctx);
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

        if (url.pathname === '/api/v1/xrefs') {
            try {
                return await handleXrefs(req, env, ctx);
            } catch (err) {
                return json500(err);
            }
        }

        if (url.pathname === '/api/v1/_health') {
            return Response.json({
                status: 'ok',
                version: 'V0.6',
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
