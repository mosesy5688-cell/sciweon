// @ts-nocheck
/**
 * RK-16A0 — STRUCTURED serving-inventory activation gate.
 *
 * Before RK-16A0, STRUCTURED_INVENTORY was DEAD config: validateCandidate only
 * decode-probed the ONE compound shard + HEAD-probed the xref/search/neg keys for
 * size>0. A present-but-undecodable structured family (wrong gzip / not JSON /
 * manifest-present-but-shard-missing-or-non-NXVF) passed yet 503s the live reader
 * — the RK-15 bug class for structured surfaces. enforceCompleteStructuredInventory
 * makes STRUCTURED_INVENTORY a REAL caller-independent gate: EVERY family is
 * GET+decode-probed at the candidate object_prefix.
 *
 * The founder-required RED: an INCOMPLETE family (a "papers"-like sharded family
 * whose manifest exists but its sample shard is MISSING) must make the gate THROW
 * AND, routed through validateCandidate, the candidate must NOT reach ACTIVE
 * (latest pointer unchanged / no CAS).
 *
 * (Mock S3 emulates R2 GET/HEAD/conditional-PUT; true R2 honoring is confirmed
 * live by the workflows — these lock the GATE LOGIC.)
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { enforceCompleteStructuredInventory } from '../../scripts/factory/lib/candidate-structured-inventory.js';
import { validateCandidate, buildAndSealCandidate } from '../../scripts/factory/lib/stage-4-activate.js';
import {
    compoundsManifestKey, compoundsShardKey, negManifestKey, negShardKey,
    xrefIndexKey, searchProjectionKey, buildNegKeyContract,
} from '../../scripts/factory/lib/snapshot-identity.js';
import { SATELLITE_INVENTORY } from '../../scripts/factory/lib/snapshot-inventory.js';

const BUCKET = 'b';
const PREFIX = 'snapshots/2026-06-15/900-1/';
const LATEST_KEY = 'snapshots/latest.json';

// neg-evidence is CONDITIONAL + HASH-bucketed (RK-16A0): probed ONLY when the seal
// declares it (neg_evidence_manifest_key) + resolved from required_inventory. This
// seal declares neg at bucket 0 so the standalone tests probe it (compounds/xref/
// search are HARD-required regardless of the seal).
const SEAL_WITH_NEG = {
    neg_evidence_manifest_key: `${PREFIX}neg-evidence/`,
    required_inventory: [negManifestKey(PREFIX, 0)],
};

// A minimal but VALID NXVF V4.1 container header: "NXVF" magic at byte 0,
// version 0x41 at byte 4, EntityCount=N (>0) UInt32LE at byte 11, >=29 bytes.
function nxvfShard(entityCount = 3) {
    const buf = Buffer.alloc(29, 0);
    Buffer.from([0x4e, 0x58, 0x56, 0x46]).copy(buf, 0); // NXVF
    buf.writeUInt8(0x41, 4);
    buf.writeUInt32LE(entityCount, 11);
    return buf;
}

function shardManifest(bucket: number, shards = [0]) {
    return JSON.stringify({
        version: '1.0', bucket, object_prefix: PREFIX,
        shard_hashes: shards.map(s => ({ shard: s, filename: `shard-${String(s).padStart(3, '0')}.bin`, sha256: 'x', size_bytes: 29 })),
    });
}

/** Mock R2: GET/HEAD/conditional-PUT, recording writes so a test can assert that
 * latest.json was NEVER swapped (no CAS) for an incomplete candidate. */
function makeMock() {
    const store = new Map<string, { body: any }>();
    return {
        store,
        seed(key: string, body: any) { store.set(key, { body }); },
        async send(cmd: any) {
            const name = cmd.constructor.name;
            const { Key } = cmd.input;
            if (name === 'GetObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const buf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
                async function* gen() { yield buf; }
                return { Body: gen() };
            }
            if (name === 'HeadObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const len = Buffer.isBuffer(o.body) ? o.body.length : Buffer.byteLength(o.body);
                return { ContentLength: len };
            }
            const exists = store.get(Key);
            if (cmd.input.IfNoneMatch === '*' && exists) {
                const e: any = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            store.set(Key, { body: cmd.input.Body });
            return {};
        },
    };
}

/** Seed a COMPLETE structured inventory at PREFIX: compounds + neg sharded
 * (manifest + valid NXVF shard) + xref (gzipped JSON object) + search (gzipped
 * JSONL). Returns the mock. */
function seedCompleteStructured() {
    const mock = makeMock();
    mock.seed(compoundsManifestKey(PREFIX, 0), shardManifest(0));
    mock.seed(compoundsShardKey(PREFIX, 0, 0), nxvfShard());
    mock.seed(negManifestKey(PREFIX, 0), shardManifest(0));
    mock.seed(negShardKey(PREFIX, 0, 0), nxvfShard());
    mock.seed(xrefIndexKey(PREFIX), gzipSync(Buffer.from(JSON.stringify({ version: '1.0', routing: { CHEMBL25: 2244 } }))));
    mock.seed(searchProjectionKey(PREFIX), gzipSync(Buffer.from(JSON.stringify({ cid: 2244, name: 'aspirin' }) + '\n')));
    return mock;
}

/** Seed the COMPLETE satellite serving set (reader-decodable gz) at PREFIX so
 * validateCandidate's satellite gate (b2) passes — used by the validateCandidate
 * route test, which targets the STRUCTURED gate specifically. */
function seedSatellites(mock: any) {
    for (const e of SATELLITE_INVENTORY) {
        mock.seed(`${PREFIX}${e.key_suffix}`, gzipSync(Buffer.from(JSON.stringify({ ok: true, file: e.snapshot_file }) + '\n')));
    }
}

describe('RK-16A0 — enforceCompleteStructuredInventory (GREEN)', () => {
    it('a complete structured inventory (compounds+neg+xref+search) passes', async () => {
        const mock = seedCompleteStructured();
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: SEAL_WITH_NEG }),
        ).resolves.toBeUndefined();
    });

    it('with NO neg declared in the seal, the conditional neg family is SKIPPED (compounds/xref/search still probed)', async () => {
        const mock = seedCompleteStructured();
        // neg manifest/shard absent from the store entirely, and seal omits the
        // neg key -> the conditional neg probe is skipped; HARD families still pass.
        mock.store.delete(negManifestKey(PREFIX, 0));
        mock.store.delete(negShardKey(PREFIX, 0, 0));
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: {} }),
        ).resolves.toBeUndefined();
    });
});

describe('RK-16A0 — enforceCompleteStructuredInventory (RED, structured gates)', () => {
    it('missing sharded manifest -> THROWS [ACTIVATE]', async () => {
        const mock = seedCompleteStructured();
        mock.store.delete(negManifestKey(PREFIX, 0));
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: SEAL_WITH_NEG }),
        ).rejects.toThrow(/\[ACTIVATE\] structured family incomplete \(neg-evidence\)/);
    });

    it('empty shard_hashes -> THROWS [ACTIVATE]', async () => {
        const mock = seedCompleteStructured();
        mock.store.set(compoundsManifestKey(PREFIX, 0), { body: shardManifest(0, []) });
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: SEAL_WITH_NEG }),
        ).rejects.toThrow(/structured manifest has no shards/);
    });

    it('non-NXVF shard -> THROWS [ACTIVATE] failed to decode', async () => {
        const mock = seedCompleteStructured();
        mock.store.set(compoundsShardKey(PREFIX, 0, 0), { body: Buffer.from('not-nxvf-bytes-here-padding-xx') });
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: SEAL_WITH_NEG }),
        ).rejects.toThrow(/structured sample shard failed to decode/);
    });

    it('sharded manifest present but sample shard MISSING -> THROWS [ACTIVATE]', async () => {
        const mock = seedCompleteStructured();
        mock.store.delete(compoundsShardKey(PREFIX, 0, 0));
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: SEAL_WITH_NEG }),
        ).rejects.toThrow(/structured sample shard missing/);
    });

    it('projection_gz MISSING -> THROWS [ACTIVATE]', async () => {
        const mock = seedCompleteStructured();
        mock.store.delete(xrefIndexKey(PREFIX));
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: SEAL_WITH_NEG }),
        ).rejects.toThrow(/structured projection missing \(xref-index\)/);
    });

    it('projection_gz CORRUPT gzip -> THROWS [ACTIVATE] not gunzip-decodable', async () => {
        const mock = seedCompleteStructured();
        mock.store.set(searchProjectionKey(PREFIX), { body: Buffer.from('this is not gzip at all') });
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, seal: SEAL_WITH_NEG }),
        ).rejects.toThrow(/structured projection not gunzip-decodable \(compounds-search\)/);
    });
});

describe('RK-16A0 — incomplete papers family must NOT go ACTIVE (founder-required)', () => {
    // An injected inventory with a "papers"-like sharded family whose manifest
    // exists but its sample shard is MISSING. The gate MUST throw for it directly,
    // AND routed through validateCandidate the candidate must NOT reach ACTIVE.
    const PAPERS_INVENTORY = [
        {
            id: 'papers', kind: 'sharded',
            derive: (p: string, bucket = 0) => `${p}papers/bucket-${String(bucket).padStart(4, '0')}/manifest.json`,
            deriveShard: (p: string, bucket: number, shard: number) => `${p}papers/bucket-${String(bucket).padStart(4, '0')}/shard-${String(shard).padStart(3, '0')}.bin`,
        },
    ];

    function seedPapersManifestOnly(mock: any) {
        // manifest present (declares shard 0) but the shard object is NOT seeded.
        mock.seed(`${PREFIX}papers/bucket-0000/manifest.json`, shardManifest(0, [0]));
    }

    it('enforceCompleteStructuredInventory THROWS for the incomplete papers family', async () => {
        const mock = makeMock();
        seedPapersManifestOnly(mock);
        await expect(
            enforceCompleteStructuredInventory({ client: mock, bucket: BUCKET, objectPrefix: PREFIX, inventory: PAPERS_INVENTORY }),
        ).rejects.toThrow(/\[ACTIVATE\] structured family incomplete \(papers\)/);
    });

    it('routed through validateCandidate, an incomplete structured family does NOT reach ACTIVE (latest unchanged, no CAS)', async () => {
        // A candidate complete in EVERY satellite + structured surface EXCEPT one
        // structured family whose sample shard is missing (the "papers"-class
        // incompleteness, here modeled on the REAL wired STRUCTURED_INVENTORY by
        // deleting the neg-evidence sample shard). validateCandidate must THROW at
        // the RK-16A0 gate, BEFORE any latest.json swap -> latest unchanged.
        const mock = seedCompleteStructured();
        seedSatellites(mock);
        // Seed an OLD production latest so a stray CAS would be detectable.
        mock.seed(LATEST_KEY, JSON.stringify({ latest_snapshot_date: '2000-01-01' }));

        const identity = {
            snapshotId: '2026-06-15/900-1', objectPrefix: PREFIX, snapshotDate: '2026-06-15',
            runId: '900', runAttempt: '1', commitSha: 'deadbeef',
        };
        const compoundManifest = { bucket: 0, total_records: 3, shard_hashes: [{ shard: 0, filename: 'shard-000.bin', sha256: 'x', size_bytes: 29 }] };
        const neg = buildNegKeyContract(PREFIX, { manifestKeys: [negManifestKey(PREFIX, 0)] });
        const { manifestHash } = await buildAndSealCandidate({
            client: mock, bucket: BUCKET, identity, compoundManifest, neg, hasXref: true, hasSearch: true,
        });

        // Sanity: the COMPLETE candidate validates (seal + all gates sound).
        await expect(
            validateCandidate({ client: mock, bucket: BUCKET, identity, expectedHash: manifestHash }),
        ).resolves.toEqual({ state: 'VALIDATED' });

        // Now make ONE structured family incomplete (neg sample shard missing).
        mock.store.delete(negShardKey(PREFIX, 0, 0));
        await expect(
            validateCandidate({ client: mock, bucket: BUCKET, identity, expectedHash: manifestHash }),
        ).rejects.toThrow(/\[ACTIVATE\] structured family incomplete \(neg-evidence\)/);

        // CRITICAL: latest.json was NEVER swapped (validateCandidate throws strictly
        // BEFORE the CAS swap; the gate failing aborts activation -> no ACTIVE).
        expect(JSON.parse(mock.store.get(LATEST_KEY).body).latest_snapshot_date).toBe('2000-01-01');
    });
});
