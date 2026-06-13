/**
 * RK-15 V3-C — the SURFACE REGISTRY (built from the REAL route definitions in
 * src/worker.ts + src/worker/api/*.ts — NO guessing) and the live HTTP probe.
 *
 * Every entry cites the source file:line of the route regex / dispatch literal.
 * Surfaces with NO public HTTP route are recorded `applicable:false` WITH the
 * router evidence (src/worker.ts) — a guessed-path 404 is NEVER recorded as a
 * product failure and NEVER silently skipped.
 *
 * Route forensics (verified 2026-06-13 against HEAD src/worker.ts):
 *   - compound            GET /api/v1/compound/<id>                  compound.ts:21
 *   - negative-evidence   GET /api/v1/compound/<id>/negative-evidence neg-evidence.ts:26 (router worker.ts:54)
 *   - repurposing         GET /api/v1/compound/<id>/repurposing-evidence repurposing-evidence.ts:24 (worker.ts:62)
 *   - bioactivities       GET /api/v1/compound/<id>/bioactivities    bioactivities.ts:13 (worker.ts:70)
 *   - trials              GET /api/v1/compound/<id>/trials           trials.ts:13 (worker.ts:78)
 *   - papers              GET /api/v1/compound/<id>/papers           papers.ts:13 (worker.ts:86)
 *   - target              GET /api/v1/target/<uniprot>[/...]         target.ts:27 (worker.ts:102)
 *   - mcp                 POST /api/mcp | /api/v1/mcp                mcp.ts (worker.ts:110)
 *   - xrefs               GET /api/v1/xrefs?id=<id>                  xrefs.ts:23 (worker.ts:118)
 *   - health              GET /api/v1/_health                       worker.ts:126
 *   - search/entity       NOT APPLICABLE — NO PUBLIC ROUTE in the router (worker.ts:54-135);
 *                         `/api/v1/entity/<id>` is only a URL string baked into
 *                         response payloads (neg-evidence-response.ts:63,
 *                         repurposing-aggregator.ts:222), never dispatched.
 */

const KEY_UNIPROT = 'P00533'; // EGFR — a stable, well-known accession for the target probe.

/** Build the registry. cidFor(name) resolves the live test CID for a surface. */
export function buildSurfaceRegistry({ tier1Cid, namedCids }) {
    const c = tier1Cid;
    return [
        { surface: 'compound', applicable: true, method: 'GET', path: `/api/v1/compound/${c}`, route: '/^\\/api\\/v1\\/compound\\/([^/]+)$/', evidence: 'src/worker/api/compound.ts:21', expect_keys: ['id', 'compound'] },
        { surface: 'negative-evidence', applicable: true, method: 'GET', path: `/api/v1/compound/${c}/negative-evidence`, route: '/^\\/api\\/v1\\/compound\\/([^/]+)\\/negative-evidence$/', evidence: 'src/worker/api/negative-evidence.ts:26 (router src/worker.ts:54)', expect_keys: [] },
        { surface: 'repurposing-evidence', applicable: true, method: 'GET', path: `/api/v1/compound/${c}/repurposing-evidence`, route: '/^\\/api\\/v1\\/compound\\/([^/]+)\\/repurposing-evidence$/', evidence: 'src/worker/api/repurposing-evidence.ts:24 (router src/worker.ts:62)', expect_keys: [] },
        { surface: 'bioactivities', applicable: true, method: 'GET', path: `/api/v1/compound/${c}/bioactivities`, route: '/^\\/api\\/v1\\/compound\\/([^/]+)\\/bioactivities$/', evidence: 'src/worker/api/bioactivities.ts:13 (router src/worker.ts:70)', expect_keys: ['id', 'count', 'bioactivities'] },
        { surface: 'trials', applicable: true, method: 'GET', path: `/api/v1/compound/${c}/trials`, route: '/^\\/api\\/v1\\/compound\\/([^/]+)\\/trials$/', evidence: 'src/worker/api/trials.ts:13 (router src/worker.ts:78)', expect_keys: ['id', 'count', 'trials'] },
        { surface: 'papers', applicable: true, method: 'GET', path: `/api/v1/compound/${c}/papers`, route: '/^\\/api\\/v1\\/compound\\/([^/]+)\\/papers$/', evidence: 'src/worker/api/papers.ts:13 (router src/worker.ts:86)', expect_keys: ['id', 'count', 'papers'] },
        { surface: 'target', applicable: true, method: 'GET', path: `/api/v1/target/${KEY_UNIPROT}`, route: '/^\\/api\\/v1\\/target\\/([^/]+)(?:\\/(drugs|trials|negative-evidence))?$/', evidence: 'src/worker/api/target.ts:27 (router src/worker.ts:102)', expect_keys: ['snapshot_date', 'target'], absence_ok: true },
        { surface: 'xrefs', applicable: true, method: 'GET', path: `/api/v1/xrefs?id=${c}`, route: "url.pathname === '/api/v1/xrefs'", evidence: 'src/worker/api/xrefs.ts:23 (router src/worker.ts:118)', expect_keys: ['resolved'] },
        { surface: 'mcp', applicable: true, method: 'POST', path: '/api/v1/mcp', route: "url.pathname === '/api/mcp' || '/api/v1/mcp'", evidence: 'src/worker/api/mcp.ts (router src/worker.ts:110)', mcp: true, expect_keys: ['jsonrpc'] },
        { surface: 'health', applicable: true, method: 'GET', path: '/api/v1/_health', route: "url.pathname === '/api/v1/_health'", evidence: 'src/worker.ts:126', expect_keys: ['status', 'version', 'r2_binding'] },
        { surface: 'search', applicable: false, reason: 'NOT APPLICABLE — NO PUBLIC ROUTE', evidence: 'src/worker.ts:54-135 — the router has no /api/v1/search dispatch' },
        { surface: 'entity', applicable: false, reason: 'NOT APPLICABLE — NO PUBLIC ROUTE', evidence: 'src/worker.ts:54-135 — /api/v1/entity/<id> is only a URL string in payloads (neg-evidence-response.ts:63, repurposing-aggregator.ts:222), never dispatched' },
    ];
}

/** One live probe of a surface. Read-only HTTP GET (or MCP POST). Returns the
 * normalized sample {status, ok, tier, faers_term_count, faers_total_count, keys}. */
export async function probeSurface(baseUrl, surface, fetchImpl = fetch) {
    if (!surface.applicable) return { applicable: false, surface: surface.surface };
    const url = `${baseUrl.replace(/\/$/, '')}${surface.path}`;
    const init = surface.mcp
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }
        : { method: 'GET' };
    let res, bodyText, body = null;
    try {
        res = await fetchImpl(url, init);
        bodyText = await res.text();
        try { body = JSON.parse(bodyText); } catch { body = null; }
    } catch (err) {
        return { surface: surface.surface, status: 0, ok: false, error: String(err?.message ?? err) };
    }
    const compound = body?.compound ?? null;
    const fda = compound?.fda_signals ?? null;
    return {
        surface: surface.surface,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        tier: compound?._tier ?? null,
        faers_term_count: Array.isArray(fda?.faers_top_adr_terms) ? fda.faers_top_adr_terms.length : 0,
        faers_total_count: typeof fda?.faers_total_top_count === 'number' ? fda.faers_total_top_count : 0,
        keys: body && typeof body === 'object' ? Object.keys(body) : [],
    };
}
