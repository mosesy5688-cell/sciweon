/**
 * GET /api/v1/xrefs?id=<identifier> — V0.5.8 Wave C1-2 Phase 1.
 *
 * Resolves any supported external identifier (CID / CHEMBL / InChIKey /
 * UNII / DrugBank / ChEBI / KEGG / RxCUI) to the canonical Sciweon
 * compound and returns its cross-reference bundle. Different surface from
 * `/api/v1/compound/:id` — that endpoint returns the full compound entity
 * (incl. bioactivities, fingerprint, etc.); xrefs is a focused subset for
 * agents that just need to translate between identifier namespaces.
 *
 * Contract:
 *   200  { resolved: true, canonical_id, matched_on, xrefs }
 *   400  identifier missing or empty
 *   404  identifier did not resolve to any Sciweon compound
 *   405  non-GET method
 *   503  R2 binding missing
 */

import type { Env } from '../../worker';
import { resolveEntity } from '../lib/entity-resolver';
import { loadTier1 } from '../lib/compound-loader';

export async function handleXrefs(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return Response.json({ error: 'Method not allowed', allowed: ['GET', 'HEAD'] }, { status: 405 });
    }
    const url = new URL(req.url);
    const raw = url.searchParams.get('id')
        ?? url.searchParams.get('cid')
        ?? url.searchParams.get('chembl_id')
        ?? url.searchParams.get('inchi_key');
    if (!raw || raw.trim().length === 0) {
        return Response.json(
            { error: 'Identifier required', detail: 'Pass ?id=<identifier> (or alias ?cid=, ?chembl_id=, ?inchi_key=).' },
            { status: 400 },
        );
    }
    if (!env.SCIWEON_R2) {
        return Response.json(
            { error: 'Data layer not configured', detail: 'R2 binding SCIWEON_R2 is not bound to this Worker.' },
            { status: 503 },
        );
    }
    const resolved = await resolveEntity(env.SCIWEON_R2, raw);
    if (!resolved) {
        return Response.json({ resolved: false, query: raw }, {
            status: 404,
            headers: { 'cache-control': 'public, max-age=60' },
        });
    }
    const tier1 = await loadTier1(env.SCIWEON_R2, resolved.cid);
    if (!tier1) {
        // Resolved but data file is gone — surface as 404 with explicit reason.
        return Response.json(
            { resolved: false, query: raw, detail: 'Identifier matched but compound data missing in current snapshot.' },
            { status: 404 },
        );
    }
    return Response.json({
        resolved: true,
        canonical_id: resolved.canonical,
        matched_on: resolved.matched_on,
        xrefs: {
            pubchem_cid: tier1.pubchem_cid ?? null,
            chembl_id: tier1.chembl_id ?? null,
            inchi_key: tier1.inchi_key ?? null,
            external_ids: tier1.external_ids ?? {},
        },
    }, {
        status: 200,
        headers: {
            'cache-control': 'public, max-age=300, s-maxage=900',
            'x-sciweon-schema-minor': '1.0',
        },
    });
}
