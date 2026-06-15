// @ts-nocheck
/**
 * RK-16A3 — the A0 guarantee EXTENDED to posting/graph families, routed through
 * validateCandidate: a candidate complete in every existing surface PLUS a posting
 * family validates; the SAME candidate with an INCOMPLETE posting family (sample
 * canonical record missing) makes validateCandidate THROW BEFORE any latest.json
 * swap -> never reaches ACTIVE.
 *
 * The posting family is injected via the `inventory` param (default production
 * STRUCTURED_INVENTORY registers none, so this is purely additive / no-op for
 * current candidates). The attestation hash is bound into the seal via the new
 * buildAndSealCandidate postingFamilies param.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { buildAndSealCandidate, validateCandidate } from '../../../scripts/factory/lib/stage-4-activate.js';
import { STRUCTURED_INVENTORY } from '../../../scripts/factory/lib/snapshot-inventory.js';
import {
    compoundsManifestKey, compoundsShardKey, negManifestKey, negShardKey,
    xrefIndexKey, searchProjectionKey, buildNegKeyContract,
} from '../../../scripts/factory/lib/snapshot-identity.js';
import { SATELLITE_INVENTORY } from '../../../scripts/factory/lib/snapshot-inventory.js';
import { buildGraphFamilyFixture, FAMILY_ID } from './_graph-fixture.js';

const BUCKET = 'b';
const PREFIX = 'snapshots/2026-06-15/810-1/';
const LATEST_KEY = 'snapshots/latest.json';

function nxvfShard(entityCount = 3) {
    const buf = Buffer.alloc(29, 0);
    Buffer.from([0x4e, 0x58, 0x56, 0x46]).copy(buf, 0);
    buf.writeUInt8(0x41, 4);
    buf.writeUInt32LE(entityCount, 11);
    return buf;
}
function shardManifest(bucket, shards = [0]) {
    return JSON.stringify({
        version: '1.0', bucket, object_prefix: PREFIX,
        shard_hashes: shards.map((s) => ({ shard: s, filename: `shard-${String(s).padStart(3, '0')}.bin`, sha256: 'x', size_bytes: 29 })),
    });
}

function makeMock() {
    const store = new Map();
    return {
        store,
        seed(key, body) { store.set(key, { body }); },
        async send(cmd) {
            const name = cmd.constructor.name;
            const { Key } = cmd.input;
            if (name === 'GetObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const buf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
                async function* gen() { yield buf; }
                return { Body: gen() };
            }
            if (name === 'HeadObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const len = Buffer.isBuffer(o.body) ? o.body.length : Buffer.byteLength(o.body);
                return { ContentLength: len };
            }
            if (cmd.input.IfNoneMatch === '*' && store.has(Key)) {
                const e = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            store.set(Key, { body: cmd.input.Body });
            return {};
        },
    };
}

/** Seed the full current-shape candidate (structured + satellites) into `mock`. */
function seedBaseline(mock) {
    mock.seed(compoundsManifestKey(PREFIX, 0), shardManifest(0));
    mock.seed(compoundsShardKey(PREFIX, 0, 0), nxvfShard());
    mock.seed(negManifestKey(PREFIX, 0), shardManifest(0));
    mock.seed(negShardKey(PREFIX, 0, 0), nxvfShard());
    mock.seed(xrefIndexKey(PREFIX), gzipSync(Buffer.from(JSON.stringify({ version: '1.0', routing: { CHEMBL25: 2244 } }))));
    mock.seed(searchProjectionKey(PREFIX), gzipSync(Buffer.from(JSON.stringify({ cid: 2244, name: 'aspirin' }) + '\n')));
    for (const e of SATELLITE_INVENTORY) {
        mock.seed(`${PREFIX}${e.key_suffix}`, gzipSync(Buffer.from(JSON.stringify({ ok: true, file: e.snapshot_file }) + '\n')));
    }
}

const IDENTITY = {
    snapshotId: '2026-06-15/810-1', objectPrefix: PREFIX, snapshotDate: '2026-06-15',
    runId: '810', runAttempt: '1', commitSha: 'deadbeef',
};
const COMPOUND_MANIFEST = { bucket: 0, total_records: 3, shard_hashes: [{ shard: 0, filename: 'shard-000.bin', sha256: 'x', size_bytes: 29 }] };

/** Build the candidate (baseline + posting family) into ONE mock; return ctx. */
async function buildCandidateWithGraph() {
    const fix = await buildGraphFamilyFixture({ prefix: PREFIX });
    const mock = makeMock();
    seedBaseline(mock);
    // copy the posting-family objects from the fixture mock into the candidate mock.
    for (const [k, v] of fix.mock.store) mock.seed(k, v.body);
    mock.seed(LATEST_KEY, JSON.stringify({ latest_snapshot_date: '2000-01-01' }));

    const neg = buildNegKeyContract(PREFIX, { manifestKeys: [negManifestKey(PREFIX, 0)] });
    const { manifestHash } = await buildAndSealCandidate({
        client: mock, bucket: BUCKET, identity: IDENTITY, compoundManifest: COMPOUND_MANIFEST,
        neg, hasXref: true, hasSearch: true,
        postingFamilies: [{ id: FAMILY_ID, attestation_hash: fix.attestationHash }],
    });
    const inventory = [...STRUCTURED_INVENTORY, fix.descriptor];
    return { mock, manifestHash, inventory, fix };
}

describe('RK-16A3 — A0 guarantee extended to posting/graph families (validateCandidate route)', () => {
    it('a COMPLETE posting family validates through validateCandidate -> VALIDATED', async () => {
        const { mock, manifestHash, inventory } = await buildCandidateWithGraph();
        await expect(
            validateCandidate({ client: mock, bucket: BUCKET, identity: IDENTITY, expectedHash: manifestHash, inventory }),
        ).resolves.toEqual({ state: 'VALIDATED' });
    });

    it('an INCOMPLETE posting family (canonical record missing) THROWS, never reaches ACTIVE', async () => {
        const { mock, manifestHash, inventory, fix } = await buildCandidateWithGraph();
        // Remove the sample canonical record shard -> the graph probe's last hop fails.
        mock.store.delete(fix.canonShardKey);
        await expect(
            validateCandidate({ client: mock, bucket: BUCKET, identity: IDENTITY, expectedHash: manifestHash, inventory }),
        ).rejects.toThrow(/\[ACTIVATE\] graph hop "canonical_record" object missing/);
        // latest.json was NEVER swapped (validate throws strictly before any CAS).
        expect(JSON.parse(mock.store.get(LATEST_KEY).body).latest_snapshot_date).toBe('2000-01-01');
    });
});
