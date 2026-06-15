/**
 * RK-16A0 — candidate STRUCTURED serving-inventory activation gate.
 *
 * Mirror of enforceCompleteSatelliteInventory (candidate-satellite-inventory.js)
 * for the STRUCTURED families. Before RK-16A0, STRUCTURED_INVENTORY was dead
 * config: nothing iterated it; validateCandidate only decode-probed the ONE
 * compound shard + HEAD-probed the xref/search/neg keys (size>0). A present-but-
 * undecodable projection (wrong gzip, not JSON) or a present-manifest-but-missing-
 * /non-NXVF shard would pass a size check yet 503 the live reader — the RK-15 bug
 * class, for structured surfaces this time.
 *
 * This module makes STRUCTURED_INVENTORY a REAL caller-independent gate: for
 * EVERY declared family it GET+decode-probes the actual serving object(s) at the
 * candidate object_prefix, INDEPENDENT of the seal's self-declaration and of any
 * caller param. ANY caller (the V3 harness OR the real F4 orchestrator) gets
 * completeness enforced; an incomplete structured family fails LOUD with an
 * [ACTIVATE] message that names the family id + the offending key.
 */

import { gunzipSync } from 'zlib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { STRUCTURED_INVENTORY } from './snapshot-inventory.js';
import { probeSampleShard } from './candidate-shard-probe.js';

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

/**
 * Decode-probe ONE 'projection_gz' family: GET the .gz key, assert non-empty,
 * gunzip, then assert a parseable record — JSON.parse the WHOLE text for
 * format:'json' (a single gzipped JSON object, e.g. xref-index), or JSON.parse
 * the FIRST non-empty line for format:'jsonl' (gzipped JSONL, e.g. compounds-
 * search). Throws (fail-loud) naming the family id on every gate.
 */
async function probeProjectionGz({ client, bucket, key, format, id }) {
    let buf;
    try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        buf = await streamToBuffer(res.Body);
    } catch (err) {
        throw new Error(`[ACTIVATE] structured projection missing (${id}): ${key} (${err.message})`);
    }
    if (!buf || buf.length === 0) {
        throw new Error(`[ACTIVATE] structured projection is empty (${id}): ${key}`);
    }
    let text;
    try { text = gunzipSync(buf).toString('utf-8'); }
    catch (err) { throw new Error(`[ACTIVATE] structured projection not gunzip-decodable (${id}): ${key} (${err.message})`); }
    if (format === 'json') {
        try { JSON.parse(text); }
        catch (err) { throw new Error(`[ACTIVATE] structured projection is not valid JSON (${id}): ${key} (${err.message})`); }
        return;
    }
    // 'jsonl': the first non-empty line must be a parseable JSON record.
    const firstLine = text.split('\n').find(l => l.trim().length > 0);
    if (!firstLine) {
        throw new Error(`[ACTIVATE] structured projection decodes to ZERO records (${id}): ${key}`);
    }
    try { JSON.parse(firstLine); }
    catch (err) { throw new Error(`[ACTIVATE] structured projection first record is not valid JSON (${id}): ${key} (${err.message})`); }
}

/**
 * RK-16A0 — the AUTHORITATIVE structured-completeness gate. For EVERY entry in
 * `inventory` (default = the real STRUCTURED_INVENTORY; injectable for tests):
 *   kind 'sharded'       -> probeSampleShard against entry.derive(objectPrefix)
 *                           + entry.deriveShard (GET manifest, assert >=1 shard,
 *                           GET + NXVF-decode the sample shard).
 *   kind 'projection_gz' -> probeProjectionGz against entry.derive(objectPrefix)
 *                           (GET .gz, non-empty, gunzip, parse per entry.format).
 * Throws (fail-loud) on the FIRST failing family, naming its id. Called by
 * validateCandidate BEFORE it returns VALIDATED — i.e. before the CAS swap — so
 * an incomplete structured family never reaches ACTIVE for ANY caller.
 *
 * CONDITIONAL families: if `entry.conditionalOn` is set and the candidate `seal`
 * does NOT declare that key (falsy), the family was legitimately skipped by the
 * producer (e.g. neg-evidence when the real F4 orchestrator passes neg:null) —
 * SKIP its probe. HARD-required families (no conditionalOn: compounds/xref/
 * search) are ALWAYS probed regardless of the seal.
 */
export async function enforceCompleteStructuredInventory({
    client, bucket, objectPrefix, seal, inventory = STRUCTURED_INVENTORY,
}) {
    for (const entry of inventory) {
        if (entry.conditionalOn && !seal?.[entry.conditionalOn]) {
            continue; // conditional family not declared present -> legitimately skipped
        }
        if (entry.kind === 'sharded') {
            // Resolve the actual manifest key. HASH-bucketed families (neg) expose
            // resolveManifestKey(seal, prefix) to pull the REAL per-bucket manifest
            // recorded in the seal; otherwise derive() (bucket-0) is authoritative
            // (compounds publish a single bucket-0 manifest).
            const manifestKey = entry.resolveManifestKey
                ? entry.resolveManifestKey(seal, objectPrefix)
                : entry.derive(objectPrefix);
            if (!manifestKey) {
                throw new Error(`[ACTIVATE] structured family incomplete (${entry.id}): `
                    + `seal declares ${entry.conditionalOn} present but no per-bucket manifest key found in required_inventory`);
            }
            try {
                await probeSampleShard({
                    client, bucket, objectPrefix, manifestKey, deriveShard: entry.deriveShard,
                });
            } catch (err) {
                throw new Error(`[ACTIVATE] structured family incomplete (${entry.id}): ${err.message}`);
            }
        } else if (entry.kind === 'projection_gz') {
            await probeProjectionGz({
                client, bucket, key: entry.derive(objectPrefix), format: entry.format, id: entry.id,
            });
        } else {
            throw new Error(`[ACTIVATE] structured inventory entry has unknown kind (${entry.id}): ${entry.kind}`);
        }
    }
}
