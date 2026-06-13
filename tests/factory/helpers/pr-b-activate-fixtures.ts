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
import { publishCompoundShards } from '../../../scripts/factory/lib/compound-shard-publisher.js';
import {
    objectPrefixFor, deriveSnapshotId, putCreateOnly, searchProjectionKey, xrefIndexKey,
} from '../../../scripts/factory/lib/snapshot-identity.js';

export const LATEST_KEY = 'snapshots/latest.json';

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

/** Publish one candidate's compound shards + serving-projection stand-ins. */
export async function publishCandidate(client: any, date: string, runId: string) {
    const id = deriveSnapshotId(date, runId, '1');
    const prefix = objectPrefixFor(id);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-b-'));
    const jsonl = path.join(dir, 'compounds-enriched.jsonl');
    await fs.writeFile(jsonl, COMPOUNDS.map(c => JSON.stringify(c)).join('\n'));
    const res = await publishCompoundShards({
        client, bucket: 'b', jsonlPath: jsonl, snapshotDate: date,
        outputDir: path.join(dir, 'compounds', 'bucket-0000'), objectPrefix: prefix,
    });
    await putCreateOnly(client, 'b', searchProjectionKey(prefix), Buffer.from('x'), 'application/gzip');
    await putCreateOnly(client, 'b', xrefIndexKey(prefix), Buffer.from('y'), 'application/gzip');
    const identity = { snapshotId: id, objectPrefix: prefix, snapshotDate: date, runId, runAttempt: '1', commitSha: 'deadbeef' };
    return { identity, manifest: res.manifest, prefix, dir };
}
