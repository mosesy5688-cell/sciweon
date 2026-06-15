// @ts-nocheck
/**
 * RK-15 PR-B test fixtures — a mock S3 client that EMULATES R2 conditional PUTs
 * (IfNoneMatch:'*' -> 412 on existing key; IfMatch CAS) + a candidate publisher.
 * Shared so stage-4-activate.test.ts stays under the CES 250-line cap.
 * (True R2 conditional honoring can only be confirmed live.)
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { publishCompoundShards } from '../../../scripts/factory/lib/compound-shard-publisher.js';
import {
    objectPrefixFor, deriveSnapshotId, putCreateOnly, searchProjectionKey, xrefIndexKey,
} from '../../../scripts/factory/lib/snapshot-identity.js';
import { SATELLITE_INVENTORY, requiredSatelliteKeys } from '../../../scripts/factory/lib/snapshot-inventory.js';

export const LATEST_KEY = 'snapshots/latest.json';

// Reader-decodable satellite bodies keyed by suffix (gunzip -> a parseable line).
// RK-15 full-snapshot completeness: validateCandidate now decode-probes EVERY
// SSoT-required satellite at the candidate prefix INDEPENDENT of the caller's
// satelliteKeys param — so a COMPLETE candidate fixture MUST publish them all.
export function satelliteBodies() {
    const m: Record<string, Buffer> = {};
    for (const e of SATELLITE_INVENTORY) {
        m[e.key_suffix] = gzipSync(Buffer.from(JSON.stringify({ ok: true, file: e.snapshot_file }) + '\n', 'utf-8'), { level: 9 });
    }
    return m;
}

/** Publish the COMPLETE SSoT satellite serving set under `prefix` (reader-decodable
 * gz). Returns the published satellite keys (== requiredSatelliteKeys(prefix)). */
export async function publishSatellites(client: any, prefix: string, bodies = satelliteBodies()) {
    for (const e of SATELLITE_INVENTORY) {
        await putCreateOnly(client, 'b', `${prefix}${e.key_suffix}`, bodies[e.key_suffix], 'application/gzip');
    }
    return requiredSatelliteKeys(prefix);
}

// Records every GET key in `reads` so a test can assert latest.json is NOT read
// during candidate validation. `casAlwaysFail` forces every IfMatch on
// latest.json to 412 (the CAS-failure class).
export function makeClient(opts: any = {}) {
    const store = new Map();
    const reads: string[] = [];
    let seq = 0;
    return {
        store, reads,
        async send(cmd: any) {
            const name = cmd.constructor.name;
            const { Key } = cmd.input;
            if (name === 'GetObjectCommand') {
                reads.push(Key);
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const buf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
                async function* gen() { yield buf; }
                return { ETag: o.etag, Body: gen() };
            }
            if (name === 'HeadObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const len = Buffer.isBuffer(o.body) ? o.body.length : Buffer.byteLength(o.body);
                return { ETag: o.etag, ContentLength: len };
            }
            const exists = store.get(Key);
            if (cmd.input.IfNoneMatch === '*' && exists) {
                const e: any = new Error('At least one precondition failed: PreconditionFailed');
                e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            if (opts.casAlwaysFail && Key === LATEST_KEY) {
                const e: any = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            store.set(Key, { body: cmd.input.Body, etag: `"e-${++seq}"` });
            return {};
        },
    };
}

const COMPOUNDS = [
    { pubchem_cid: 2244, inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N', chembl_id: 'CHEMBL25' },
    { pubchem_cid: 3672, inchi_key: 'XEFQLINVKFYRCS-UHFFFAOYSA-N', chembl_id: null },
];

/**
 * Publish one candidate's compound shards + serving-projection stand-ins.
 * `withSatellites` (default true) ALSO publishes the COMPLETE SSoT satellite set
 * so the candidate is COMPLETE — this is the real-F4-shaped path (snapshot-builder
 * publishes the satellites; activateValidatedCandidate is then called with NO
 * satelliteKeys, and validateCandidate enforces completeness against the SSoT).
 * Completeness tests that deliberately exercise an INCOMPLETE candidate pass
 * `withSatellites: false` and publish their own (partial/bogus) satellite set.
 */
export async function publishCandidate(client: any, date: string, runId: string, withSatellites = true) {
    const id = deriveSnapshotId(date, runId, '1');
    const prefix = objectPrefixFor(id);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-b-'));
    const jsonl = path.join(dir, 'compounds-enriched.jsonl');
    await fs.writeFile(jsonl, COMPOUNDS.map(c => JSON.stringify(c)).join('\n'));
    const res = await publishCompoundShards({
        client, bucket: 'b', jsonlPath: jsonl, snapshotDate: date,
        outputDir: path.join(dir, 'compounds', 'bucket-0000'), objectPrefix: prefix,
    });
    // RK-16A0: the activation gate now GET+decode-probes these HARD-required
    // projections (gunzip -> JSON.parse). Publish REAL gzip stand-ins, not
    // plaintext: compounds-search.jsonl.gz = a gzipped JSONL line; xref-index.json.gz
    // = a gzipped JSON object — matching the minimal shapes the readers expect.
    await putCreateOnly(client, 'b', searchProjectionKey(prefix),
        gzipSync(Buffer.from(JSON.stringify({ id: 'sciweon::compound::CID2244', name: 'aspirin' }) + '\n')), 'application/gzip');
    await putCreateOnly(client, 'b', xrefIndexKey(prefix),
        gzipSync(Buffer.from(JSON.stringify({ namespaces: {}, version: 1 }))), 'application/gzip');
    if (withSatellites) await publishSatellites(client, prefix);
    const identity = { snapshotId: id, objectPrefix: prefix, snapshotDate: date, runId, runAttempt: '1', commitSha: 'deadbeef' };
    return { identity, manifest: res.manifest, prefix, dir };
}
