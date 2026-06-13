/**
 * RK-15 V3-B — accept ONLY the exact audited candidate, then activate it with a
 * single CAS of production snapshots/latest.json. NO rebuild / NO backfill.
 *
 * Order (no purge-first):
 *   read candidate _candidate_latest.json -> assert payload hash == descriptor
 *   -> validateCandidate({identity, expectedHash: manifest_hash}) by the
 *   candidate's OWN keys -> assert snapshot_id + manifest_hash + state +
 *   required objects -> warm the legacy serving paths (GET only) -> CAS prod
 *   latest (If-Match) to the EXACT candidate payload -> re-read (ACTIVE derived
 *   from the pointer) -> serving acceptance probes.
 *
 * The ONLY write is the ONE conditional latest PUT (the V3-B guard enforces
 * exactly one PUT, key==snapshots/latest.json, carrying If-Match). ACTIVE is
 * NEVER written into a candidate object — it is derived from the post-swap
 * re-read confirming latest names this candidate.
 */

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { validateCandidate } from '../factory/lib/stage-4-activate.js';
import { rootSealKey, canonicalManifestHash } from '../factory/lib/snapshot-identity.js';
import { parseSnapshotContext } from '../../src/worker/lib/snapshot-context.ts';
import { PROD_LATEST_KEY, getObject, getObjectOrNull, headObject, sha256Hex } from './rk15-v3-lib.js';

/** The legacy warm-set: the live serving paths exercised BEFORE the swap so the
 * post-swap behavior (legacy cache keeps the OLD complete snapshot; v2 uses the
 * snapshot-id-bound namespace; never an old-manifest+new-shard mix) is
 * observable. In the harness these are GET-driven against the live worker URL;
 * in unit tests they are mocked. The REAL warm/cold behavior is only observable
 * at V3-B run time. */
export const LEGACY_WARM_TARGETS = Object.freeze([
    { label: 'aspirin/CID:2244', cid: 2244 },
    { label: 'acetaminophen', name: 'acetaminophen' },
    { label: 'ibuprofen', name: 'ibuprofen' },
    { label: 'sertraline', name: 'sertraline' },
    { label: 'warfarin', name: 'warfarin' },
    { label: 'sildenafil', name: 'sildenafil' },
    { label: 'CID:194985', cid: 194985 },
]);
export const SERVING_SURFACES = Object.freeze([
    'compound', 'negative-evidence', 'xref-routing', 'search-entity',
    'repurposing', 'satellite-endpoints', 'mcp',
]);

/** Re-read + re-validate the EXACT audited candidate by its OWN keys (never prod
 * latest). Returns { candidatePayload, candidatePayloadHash, seal, sealSnapshotId,
 * sealManifestHash, ctx }. Throws on any drift. */
export async function revalidateCandidate({ client, bucket, descriptor }) {
    const objectPrefix = descriptor.object_prefix;
    const latestKey = `${objectPrefix}_candidate_latest.json`;
    const candidatePayload = (await getObject(client, bucket, latestKey)).body.toString('utf-8');
    const candidatePayloadHash = sha256Hex(Buffer.from(candidatePayload, 'utf-8'));
    if (candidatePayloadHash !== descriptor.candidate_payload_hash) {
        throw new Error(`[V3B] candidate payload hash drift: got ${candidatePayloadHash} != descriptor ${descriptor.candidate_payload_hash}`);
    }
    const ctx = parseSnapshotContext(candidatePayload);
    // Re-read the seal + recompute its canonical hash; assert snapshot_id + hash.
    const seal = JSON.parse((await getObject(client, bucket, rootSealKey(objectPrefix))).body.toString('utf-8'));
    const { manifest_hash: sealManifestHash, ...sealCore } = seal;
    const recomputed = canonicalManifestHash(sealCore);
    if (recomputed !== sealManifestHash) throw new Error(`[V3B] candidate seal self-hash mismatch: stored ${sealManifestHash} != recomputed ${recomputed}`);
    if (seal.snapshot_id !== descriptor.snapshot_id) throw new Error(`[V3B] seal snapshot_id ${seal.snapshot_id} != descriptor ${descriptor.snapshot_id}`);
    if (sealManifestHash !== descriptor.manifest_hash) throw new Error(`[V3B] seal manifest_hash ${sealManifestHash} != descriptor ${descriptor.manifest_hash}`);
    if (!['OBJECTS_COMPLETE', 'VALIDATED', 'ACTIVATABLE'].includes(seal.state)) {
        throw new Error(`[V3B] candidate state ${seal.state} is not VALIDATED/ACTIVATABLE`);
    }
    // Full validateCandidate (inventory + manifest refs + sample shard decode).
    const identity = { snapshotId: descriptor.snapshot_id, objectPrefix };
    await validateCandidate({ client, bucket, identity, expectedHash: descriptor.manifest_hash });
    return { candidatePayload, candidatePayloadHash, seal, sealSnapshotId: seal.snapshot_id, sealManifestHash, ctx };
}

/** Warm the legacy serving paths via the live worker (GET only). `fetchImpl` is
 * injected so unit tests mock it; a missing WORKER_BASE_URL leaves the set
 * un-warmed (recorded), and any fetch error is captured per-target (non-fatal —
 * the swap is the operation under test). */
export async function warmLegacyCache({ baseUrl, fetchImpl }) {
    const warmed = [];
    if (!baseUrl || typeof fetchImpl !== 'function') {
        return { warmed, base_url: baseUrl ?? null, note: 'no WORKER_BASE_URL/fetch — warm-set NOT exercised (real warm/cold only at run time)' };
    }
    for (const t of LEGACY_WARM_TARGETS) {
        const path = t.cid != null ? `/api/compound/CID:${t.cid}` : `/api/search?q=${encodeURIComponent(t.name)}`;
        for (const surface of SERVING_SURFACES) {
            const url = `${baseUrl}${path}&_surface=${surface}`.replace('?&', '?');
            try { const res = await fetchImpl(url, { method: 'GET' }); warmed.push({ target: t.label, surface, status: res.status }); }
            catch (err) { warmed.push({ target: t.label, surface, error: String(err?.message ?? err) }); }
        }
    }
    return { warmed, base_url: baseUrl, surfaces: [...SERVING_SURFACES] };
}

/**
 * The ONE conditional latest PUT: read current production latest body+ETag+sha256,
 * then a DIRECT If-Match PUT of the EXACT candidate payload (drift-free; not a
 * merge). On a CAS conflict (412) it throws — the old latest is unchanged, NO
 * unconditional retry, NO rebuild. Returns { before, after, casSucceeded, casError }.
 */
export async function casActivate({ client, bucket, candidatePayload }) {
    const before = await getObjectOrNull(client, bucket, PROD_LATEST_KEY);
    let casSucceeded = false, casError = null, after = null;
    try {
        const put = { Bucket: bucket, Key: PROD_LATEST_KEY, Body: candidatePayload, ContentType: 'application/json' };
        // Production latest MUST already exist (live v1/v2 pointer) -> If-Match CAS.
        if (!before) throw new Error('[V3B] production latest.json missing — refusing to create it unconditionally (activation is a CAS over the live pointer)');
        put.IfMatch = before.etag;
        await client.send(new PutObjectCommand(put));
        casSucceeded = true;
        after = await getObjectOrNull(client, bucket, PROD_LATEST_KEY);
    } catch (err) { casError = err; }
    return { before, after, casSucceeded, casError };
}

/** Post-swap serving acceptance probes (GET only). Mocked in unit tests; the REAL
 * acceptance matrix (Tier-1 fda_signals, >=30 terms, no nonzero->zero, etc.) is
 * only observable at V3-B run time against the live worker. */
export async function servingAcceptance({ baseUrl, fetchImpl }) {
    if (!baseUrl || typeof fetchImpl !== 'function') {
        return { exercised: false, note: 'no WORKER_BASE_URL/fetch — acceptance matrix only observable at run time' };
    }
    const matrix = {};
    for (const t of LEGACY_WARM_TARGETS) {
        const path = t.cid != null ? `/api/compound/CID:${t.cid}` : `/api/search?q=${encodeURIComponent(t.name)}`;
        try { const res = await fetchImpl(`${baseUrl}${path}`, { method: 'GET' }); matrix[t.label] = { status: res.status }; }
        catch (err) { matrix[t.label] = { error: String(err?.message ?? err) }; }
    }
    return { exercised: true, base_url: baseUrl, matrix };
}

/** ACTIVE is derived from the pointer fact: production latest, re-read, names this
 * candidate. */
export async function deriveActiveFromPointer({ client, bucket, snapshotId, manifestHash }) {
    const latest = await getObjectOrNull(client, bucket, PROD_LATEST_KEY);
    if (!latest) return { active: false, reason: 'production latest missing after swap', latest: null };
    const obj = JSON.parse(latest.body.toString('utf-8'));
    const active = obj.layout_version === 'immutable_snapshot_v2' && obj.snapshot_id === snapshotId && obj.manifest_hash === manifestHash;
    return { active, latest: obj, etag: latest.etag, sha256: latest.sha256 };
}
