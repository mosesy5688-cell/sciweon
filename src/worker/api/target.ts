/**
 * GET /api/v1/target/:uniprot{,/drugs,/trials,/negative-evidence}
 *
 * C2-3 inverse-pivot — Sciweon's first non-compound-centric entry point.
 * Backed by the offline-built `target-index.json` (uniprot-keyed).
 *
 * Coverage caveat: only bioactivities carrying target.uniprot_accession
 * (~33.6% of the bioactivity corpus per 2026-05-21 sampling) are indexed
 * in v1. ChEMBL-only targets are deferred.
 *
 * Contract:
 *   200  full target response
 *   400  malformed uniprot accession
 *   404  target not found in the current snapshot
 *   500  unexpected internal failure
 *   502  upstream object or snapshot contract could not be validated
 *   503  R2 binding not configured, OR the target index could not be read
 *
 * Every failure body above carries failure_class + retryable. HTTP status is
 * NOT a retryability signal here: `retryable` is the only retry carrier.
 */

import type { Env } from '../../worker';
import { parseUniprotId, loadTargetIndex, getTargetEntry, type TargetEntry } from '../lib/target-loader';
import { loadSnapshotContext, SnapshotContractError } from '../lib/snapshot-context';
import { fetchR2JsonText, R2ReadError } from '../lib/r2-fetch';
import { classifyThrown, failureBody } from '../lib/failure-contract';
import { jsonWithRights } from '../lib/source-rights-filter';

export type TargetSection = 'drugs' | 'trials' | 'negative_evidence';

const PATH_RE = /^\/api\/v1\/target\/([^/]+)(?:\/(drugs|trials|negative-evidence))?$/;

// Build the response payload, expanding only the sections requested. Empty
// set => summary + counts only. Shared by REST handler + MCP tool wrapper
// so the response shape stays single-source.
export function pickTargetView(entry: TargetEntry, sections: Set<TargetSection>) {
    const out: Record<string, unknown> = {
        uniprot_accession: entry.uniprot_accession,
        protein_name: entry.protein_name,
        gene_symbol: entry.gene_symbol,
        chembl_target_id: entry.chembl_target_id,
        organism: entry.organism,
        counts: {
            compounds: entry.compound_ids.length,
            bioactivities: entry.bioactivity_ids.length,
            trials: entry.trial_ids.length,
            negative_evidence: entry.negative_evidence_ids.length,
        },
    };
    if (sections.has('drugs')) {
        out.compound_ids = entry.compound_ids;
        out.bioactivity_ids = entry.bioactivity_ids;
    }
    if (sections.has('trials')) out.trial_ids = entry.trial_ids;
    if (sections.has('negative_evidence')) out.negative_evidence_ids = entry.negative_evidence_ids;
    return out;
}

function suffixToSections(suffix: string | undefined): Set<TargetSection> {
    if (suffix === 'drugs') return new Set(['drugs']);
    if (suffix === 'trials') return new Set(['trials']);
    if (suffix === 'negative-evidence') return new Set(['negative_evidence']);
    return new Set();
}

export async function handleTarget(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return Response.json({ error: 'Method not allowed', allowed: ['GET', 'HEAD'] }, { status: 405 });
    }

    const url = new URL(req.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) {
        return Response.json({ error: 'Invalid endpoint path' }, { status: 404 });
    }
    const [, idRaw, suffixRaw] = match;
    const sections = suffixToSections(suffixRaw);

    const parsed = parseUniprotId(idRaw);
    if (!parsed.ok) {
        return Response.json({ error: 'Invalid target ID format', detail: parsed.error }, { status: 400 });
    }

    if (!env.SCIWEON_R2) {
        return Response.json(
            failureBody('Data layer not configured', 'data_layer_unconfigured',
                'R2 binding SCIWEON_R2 is not bound to this Worker.'),
            { status: 503 },
        );
    }

    let index;
    try {
        // RK-15 PR-A2: read snapshots/latest.json EXACTLY ONCE per request ->
        // ONE pinned SnapshotContext threaded into loadTargetIndex (which no
        // longer reads the pointer).
        const ctx = await loadSnapshotContext(k => fetchR2JsonText(env.SCIWEON_R2!, k));
        index = await loadTargetIndex(env.SCIWEON_R2, ctx);
    } catch (err) {
        // RK-15 PR-A2: a latest.json contract violation is an integrity failure
        // (LOUD), never the genuine-absence 404 path below.
        if (err instanceof SnapshotContractError) {
            return Response.json(
                failureBody('Data integrity error', 'snapshot_contract'),
                { status: 502 },
            );
        }
        // Rule 4c.1: dispatch on the throw site's structural discriminant, never
        // on message text. Rule 4c.2: a transport fault is never served as a
        // domain 404 - an unreadable index is a READ failure, not an absence.
        if (err instanceof R2ReadError) {
            if (err.discriminant === 'not_found') {
                return Response.json(
                    failureBody('Target index not available', 'source_unavailable',
                        'The target index could not be read from the current snapshot. This is a READ failure and NOT a finding that the target is absent.'),
                    { status: 503 },
                );
            }
            if (err.discriminant === 'disappeared' || err.discriminant === 'etag_drift'
                || err.discriminant === 'short_read') {
                return Response.json(
                    failureBody('Data integrity error', 'source_unavailable',
                        'An upstream object could not be read intact. This is a READ failure and NOT a finding that the target is absent.'),
                    { status: 502 },
                );
            }
            // range_failed / short_range_read keep their generic-500 outcome.
        }
        // Residual: only after every typed error in the union has been tested.
        // The underlying message is NEVER echoed - it can carry R2 object keys.
        return Response.json(
            failureBody('Internal server error', classifyThrown(err)),
            { status: 500 },
        );
    }

    const entry = getTargetEntry(index, parsed.canonical);
    if (!entry) {
        return Response.json(
            { error: 'Target not found', detail: `No bioactivities with uniprot_accession=${parsed.canonical} in snapshot ${index.snapshotDate}.` },
            { status: 404 },
        );
    }

    // RC-3A: composed-route serialization boundary. negative_evidence_ids[] may
    // contain faers NegEvidence ids whose slug encodes a MedDRA PT; the shared
    // filter neutralizes those id slugs (all other target fields are unaffected).
    return jsonWithRights(
        { snapshot_date: index.snapshotDate, target: pickTargetView(entry, sections) },
        {
            status: 200,
            headers: {
                'cache-control': 'public, max-age=300, s-maxage=900',
                'x-sciweon-schema-minor': '0.6.0',
                'x-sciweon-rights-filter': 'rc3a-v1',
            },
        },
    );
}
