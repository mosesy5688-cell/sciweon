/**
 * RK-15 full-snapshot completeness — candidate SATELLITE serving-inventory logic,
 * extracted from stage-4-activate.js to keep it under the CES Art 5.1 250-line cap.
 *
 * Two responsibilities, both about the WHOLE-FILE satellite serving surfaces
 * (papers/trials/trial-links/bioactivities/target-index/compounds-enriched/
 * neg-evidence whole-file) that the V3-A candidate OMITTED -> 503/404 after cutover:
 *
 *   1. SEAL ASSEMBLY (buildAndSealCandidate side): turn the caller's published
 *      satelliteKeys into the seal's `satellite_inventory` + fold them into the
 *      full required_inventory so the seal hash binds the complete-snapshot
 *      definition. This is for the hash binding + audit ONLY.
 *
 *   2. VALIDATION (validateCandidate side): the AUTHORITATIVE completeness gate.
 *      validateCandidate decode-probes EVERY satellite the SSoT
 *      (`requiredSatelliteKeys(objectPrefix)`) declares REQUIRED at the candidate
 *      object_prefix — INDEPENDENT of what the seal self-declared and INDEPENDENT
 *      of the caller's satelliteKeys param. So ANY caller (the V3 harness OR the
 *      real F4 orchestrator that passes NO satelliteKeys) gets completeness
 *      enforced: an incomplete candidate fails regardless of what it declared.
 */

import { gunzipSync } from 'zlib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { requiredSatelliteKeys, satelliteFor } from './snapshot-inventory.js';

/** The satellite key's suffix relative to the candidate prefix (e.g.
 * `papers.jsonl.gz`), used to look the surface up in SATELLITE_INVENTORY. */
export function satelliteSuffixOf(key, objectPrefix) {
    return key.startsWith(objectPrefix) ? key.slice(objectPrefix.length) : key;
}

/**
 * The seal-side satellite inventory: the COMPLETE serving inventory the caller
 * published (kept SEPARATE from the structured keys because validateCandidate
 * decode-probes satellites, not just HEADs them). Folded into required_inventory
 * by the caller so the seal hash binds the complete-snapshot definition (any drift
 * changes the manifest_hash). NOTE: this is the seal's SELF-DECLARATION for the
 * hash + audit; the ENFORCING gate is the SSoT loop below, not this list.
 */
export function satelliteInventoryForSeal(satelliteKeys) {
    return [...satelliteKeys];
}

/**
 * Decode-probe ONE satellite object: GET -> non-empty -> gunzip -> a parseable
 * first record. A present-but-corrupt/empty-after-gunzip satellite passes a HEAD
 * yet 503/404 the live reader (the V3-A bug class), so HEAD is NOT enough.
 * Throws (fail-loud) on missing/empty/undecodable. `client`/`bucket`/`key` only.
 */
async function decodeProbeSatellite(client, bucket, key) {
    let buf;
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const c of res.Body) chunks.push(c);
        buf = Buffer.concat(chunks);
    } catch (err) {
        throw new Error(`[ACTIVATE] required satellite object missing: ${key} (${err.message})`);
    }
    if (!buf || buf.length === 0) throw new Error(`[ACTIVATE] required satellite object is empty: ${key}`);
    let text;
    try { text = gunzipSync(buf).toString('utf-8'); }
    catch (err) { throw new Error(`[ACTIVATE] satellite object not gunzip-decodable (reader would 503): ${key} (${err.message})`); }
    const firstLine = text.split('\n').find(l => l.trim().length > 0);
    if (!firstLine) throw new Error(`[ACTIVATE] satellite object decodes to ZERO records (reader would serve empty/404): ${key}`);
    try { JSON.parse(firstLine); }
    catch (err) { throw new Error(`[ACTIVATE] satellite object first record is not valid JSON (reader would 503): ${key} (${err.message})`); }
}

/**
 * RK-15 full-snapshot completeness — the AUTHORITATIVE satellite-completeness gate.
 *
 * Derive the REQUIRED satellite set from the SSoT (`requiredSatelliteKeys`) at the
 * candidate `objectPrefix` and GET + decode-probe EVERY one — INDEPENDENT of the
 * seal's self-declared `satellite_inventory` and the caller's `satelliteKeys`. This
 * is what guarantees the founder hard-gate ("an incomplete candidate never reaches
 * ACTIVATABLE") for ANY caller: the real F4 orchestrator passes NO satelliteKeys,
 * but its snapshot-builder published the SNAPSHOT_FILES satellites under the prefix,
 * so the SSoT-required keys resolve + pass; an incomplete candidate fails loud.
 *
 * The seal MAY still self-declare `satellite_inventory` (for the hash binding +
 * audit); we ADDITIONALLY reject any seal-declared satellite whose suffix is not a
 * known serving surface (a malformed/over-declared seal is a contract bug), but the
 * REQUIRED set enforced is the SSoT's, never the seal's.
 */
export async function enforceCompleteSatelliteInventory({ client, bucket, objectPrefix, seal }) {
    // (1) AUTHORITATIVE gate: every SSoT-required satellite present + decodable.
    for (const key of requiredSatelliteKeys(objectPrefix)) {
        await decodeProbeSatellite(client, bucket, key);
    }
    // (2) Seal audit: any seal-declared satellite must be a known serving surface
    // (an over/mis-declared seal is rejected even though enforcement is SSoT-based).
    for (const key of seal?.satellite_inventory ?? []) {
        const suffix = satelliteSuffixOf(key, objectPrefix);
        if (!satelliteFor(suffix)) {
            throw new Error(`[ACTIVATE] sealed satellite key is not a known serving surface: ${key}`);
        }
    }
}
