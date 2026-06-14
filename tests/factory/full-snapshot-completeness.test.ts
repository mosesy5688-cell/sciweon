// @ts-nocheck
/**
 * RK-15 full-snapshot completeness — validateCandidate fail-loud + complete
 * candidate publish + caller-independent SSoT enforcement.
 *
 * The V3-A defect: an INCOMPLETE candidate (no satellites) went VALIDATED + LIVE
 * -> papers/trials/bioactivities/repurposing 503, target 404. These tests prove
 * the COMPLETE-snapshot contract: a complete candidate PASSes + every satellite
 * reader-decodes; missing/empty/corrupt/undeclared satellites FAIL with latest
 * NOT swapped; the SSoT gate holds for ANY caller (incl. the real-F4 no-
 * satelliteKeys shape). Mock S3 emulates R2 conditional PUTs (true R2 live).
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import {
    buildAndSealCandidate, validateCandidate, activateValidatedCandidate,
} from '../../scripts/factory/lib/stage-4-activate.js';
import { requiredSatelliteKeys, SATELLITE_INVENTORY } from '../../scripts/factory/lib/snapshot-inventory.js';
import { searchProjectionKey, xrefIndexKey, putCreateOnly } from '../../scripts/factory/lib/snapshot-identity.js';
import { makeClient, publishCandidate, satelliteBodies, LATEST_KEY } from './helpers/pr-b-activate-fixtures';
import { runV3A } from '../../scripts/verify/rk15-v3-candidate.js';
import { makeR2Mock, seedSource, seedProdLatest, buildSourceBuffers, PROD_LATEST_KEY } from './helpers/rk15-v3-fixtures';
import { loadTargetIndex, getTargetEntry } from '../../src/worker/lib/target-loader';

const HEAVY_MS = 60_000;
const RUN = { sourceRunId: '27413864028', date: '2026-06-13', runId: '7000', runAttempt: '1', commitSha: 'sat', targetCid: 2244 };

/** Publish a COMPLETE candidate + seal it. `withSatellites: false` on
 * publishCandidate so THIS helper owns the satellite publish (it can inject
 * overrideBodies for the corrupt/empty/zero-record cases). */
async function publishComplete(client, date, runId, overrideBodies = null) {
    const { identity, manifest, prefix } = await publishCandidate(client, date, runId, false);
    const bodies = overrideBodies ?? satelliteBodies();
    const satelliteKeys = requiredSatelliteKeys(prefix);
    for (const e of SATELLITE_INVENTORY) {
        await putCreateOnly(client, 'b', `${prefix}${e.key_suffix}`, bodies[e.key_suffix], 'application/gzip');
    }
    const { manifestHash } = await buildAndSealCandidate({
        client, bucket: 'b', identity, compoundManifest: manifest,
        negManifestKey: null, hasXref: true, hasSearch: true, satelliteKeys,
    });
    return { identity, manifest, prefix, manifestHash, satelliteKeys };
}

describe('RK-15 full-snapshot completeness — validateCandidate fail-loud', () => {
    it('(9) a COMPLETE candidate -> validateCandidate PASS', async () => {
        const client = makeClient();
        const c = await publishComplete(client, '2026-06-13', '900');
        await expect(
            validateCandidate({ client, bucket: 'b', identity: c.identity, expectedHash: c.manifestHash }),
        ).resolves.toMatchObject({ state: 'VALIDATED' });
    });

    for (const [n, suffix] of [['1', 'papers.jsonl.gz'], ['2', 'trials.jsonl.gz'], ['3', 'bioactivities.jsonl.gz'], ['4', 'target-index.json.gz']]) {
        it(`(${n}) missing ${suffix} -> validateCandidate FAIL`, async () => {
            const client = makeClient();
            const c = await publishComplete(client, '2026-06-13', `90${n}`);
            client.store.delete(`${c.prefix}${suffix}`);
            await expect(
                validateCandidate({ client, bucket: 'b', identity: c.identity, expectedHash: c.manifestHash }),
            ).rejects.toThrow(/satellite object missing/i);
        });
    }

    it('(5) missing a STRUCTURED required file (search projection) -> FAIL', async () => {
        const client = makeClient();
        const c = await publishComplete(client, '2026-06-13', '905');
        client.store.delete(searchProjectionKey(c.prefix));
        await expect(
            validateCandidate({ client, bucket: 'b', identity: c.identity, expectedHash: c.manifestHash }),
        ).rejects.toThrow(/required candidate object/i);
    });

    it('(6) an EMPTY satellite -> FAIL', async () => {
        const client = makeClient();
        const c = await publishComplete(client, '2026-06-13', '906');
        client.store.set(`${c.prefix}papers.jsonl.gz`, { body: Buffer.alloc(0), etag: '"empty"' });
        await expect(
            validateCandidate({ client, bucket: 'b', identity: c.identity, expectedHash: c.manifestHash }),
        ).rejects.toThrow(/satellite object (is empty|missing)/i);
    });

    it('(6b) a present-but-NOT-gunzip-decodable satellite -> FAIL (reader would 503)', async () => {
        const client = makeClient();
        const c = await publishComplete(client, '2026-06-13', '907');
        // Plausible bytes that are NOT valid gzip -> reader decode would throw.
        client.store.set(`${c.prefix}trials.jsonl.gz`, { body: Buffer.from('not-a-gzip-stream-at-all'), etag: '"corrupt"' });
        await expect(
            validateCandidate({ client, bucket: 'b', identity: c.identity, expectedHash: c.manifestHash }),
        ).rejects.toThrow(/not gunzip-decodable/i);
    });

    it('(6c) a satellite that decodes to ZERO records -> FAIL', async () => {
        const client = makeClient();
        const c = await publishComplete(client, '2026-06-13', '908');
        client.store.set(`${c.prefix}bioactivities.jsonl.gz`, { body: gzipSync(Buffer.from('\n\n', 'utf-8')), etag: '"blank"' });
        await expect(
            validateCandidate({ client, bucket: 'b', identity: c.identity, expectedHash: c.manifestHash }),
        ).rejects.toThrow(/ZERO records/i);
    });

    it('(8) NO satellites published (incomplete candidate) -> FAIL even though the seal under-declares', async () => {
        const client = makeClient();
        // Incomplete: NO satellites; seal UNDER-declares (empty satellite_inventory,
        // the real-F4 shape). SSoT-based validate must STILL fail (seal-independent).
        const { identity, manifest } = await publishCandidate(client, '2026-06-13', '910', false);
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest,
            negManifestKey: null, hasXref: true, hasSearch: true, // satelliteKeys omitted -> empty
        });
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).rejects.toThrow(/satellite object missing/i);
    });

    it('(8b) a sealed satellite key that is NOT a known serving surface -> FAIL', async () => {
        const client = makeClient();
        // COMPLETE candidate (all SSoT satellites present) so the SSoT loop passes;
        // the seal additionally OVER-declares a bogus key -> the seal-audit rejects it.
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-13', '911', true);
        const bogus = `${prefix}phantom.jsonl.gz`;
        await putCreateOnly(client, 'b', bogus, gzipSync(Buffer.from('{"x":1}\n')), 'application/gzip');
        const satelliteKeys = [...requiredSatelliteKeys(prefix), bogus];
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest,
            negManifestKey: null, hasXref: true, hasSearch: true, satelliteKeys,
        });
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).rejects.toThrow(/not a known serving surface/i);
    });

    it('(11) an INCOMPLETE candidate never reaches ACTIVATABLE -> latest UNCHANGED', async () => {
        const client = makeClient();
        // Publish satellites, then drop one so the validate step inside activate
        // (which seals + validates + swaps) fails BEFORE any swap.
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-13', '912', false);
        const bodies = satelliteBodies();
        const satelliteKeys = requiredSatelliteKeys(prefix);
        for (const e of SATELLITE_INVENTORY) {
            await putCreateOnly(client, 'b', `${prefix}${e.key_suffix}`, bodies[e.key_suffix], 'application/gzip');
        }
        client.store.set(LATEST_KEY, { body: JSON.stringify({ latest_snapshot_date: '2000-01-01' }), etag: '"old"' });
        client.store.delete(`${prefix}target-index.json.gz`); // satellite gone -> validate fails
        await expect(
            activateValidatedCandidate({
                client, bucket: 'b', identity, compoundManifest: manifest,
                negManifestKey: null, hasXref: true, hasSearch: true, satelliteKeys,
            }),
        ).rejects.toThrow(/satellite object missing/i);
        expect(JSON.parse(client.store.get(LATEST_KEY).body).latest_snapshot_date).toBe('2000-01-01');
    });
});

// CALLER-INDEPENDENT contract: the REAL F4 orchestrator calls
// activateValidatedCandidate WITHOUT satelliteKeys (seals an EMPTY
// satellite_inventory). validateCandidate enforces the SSoT satellites at
// object_prefix regardless -> the V3-A bug class is closed for ANY caller.
describe('RK-15 full-snapshot completeness — caller-independent SSoT enforcement (real-F4 shape)', () => {
    it('(F4-a) real-F4 shape (NO satelliteKeys) over a COMPLETE store -> ACTIVE (latest swapped)', async () => {
        const client = makeClient();
        // publishCandidate(true) publishes the SSoT satellites (as snapshot-builder
        // does); activate is then called WITHOUT satelliteKeys (the real F4 call).
        const { identity, manifest } = await publishCandidate(client, '2026-06-13', '920', true);
        client.store.set(LATEST_KEY, { body: JSON.stringify({ latest_snapshot_date: '2000-01-01' }), etag: '"old"' });
        const { manifestHash } = await activateValidatedCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest,
            negManifestKey: null, hasXref: true, hasSearch: true, // NO satelliteKeys
        });
        const latest = JSON.parse(client.store.get(LATEST_KEY).body);
        expect(latest.snapshot_id).toBe(identity.snapshotId);
        expect(latest.manifest_hash).toBe(manifestHash);
    });

    it('(F4-b) real-F4 shape (NO satelliteKeys) over an INCOMPLETE store -> FAIL, latest UNCHANGED', async () => {
        const client = makeClient();
        // INCOMPLETE (no satellites); seal under-declares; real-F4 passes NO
        // satelliteKeys. SSoT enforcement must STILL fail loud before any swap.
        const { identity, manifest } = await publishCandidate(client, '2026-06-13', '921', false);
        client.store.set(LATEST_KEY, { body: JSON.stringify({ latest_snapshot_date: '2000-01-01' }), etag: '"old"' });
        await expect(
            activateValidatedCandidate({
                client, bucket: 'b', identity, compoundManifest: manifest,
                negManifestKey: null, hasXref: true, hasSearch: true, // NO satelliteKeys
            }),
        ).rejects.toThrow(/satellite object missing/i);
        expect(JSON.parse(client.store.get(LATEST_KEY).body).latest_snapshot_date).toBe('2000-01-01');
    });
});

describe('RK-15 full-snapshot completeness — complete candidate publish (V3-A path)', () => {
    it('(10) the candidate builder publishes ALL satellites + each loader key-derivation decodes', async () => {
        const mock = makeR2Mock();
        seedSource(mock); seedProdLatest(mock);
        const r = await runV3A({ client: mock, bucket: 'b', ...RUN });
        expect(r.a_pass, JSON.stringify(r.checks)).toBe(true);
        expect(r.candidate_state).toBe('VALIDATED');
        const prefix = r.object_prefix;
        // EVERY satellite serving key was published under the candidate prefix.
        for (const key of requiredSatelliteKeys(prefix)) {
            expect([...mock.store.keys()], `missing satellite ${key}`).toContain(key);
        }
        // A real reader key-derivation: target-loader reads <prefix>target-index.json.gz.
        // Build a v2 ctx + a fetchR2GunzippedText shim over the mock store.
        const ctx = { object_prefix: prefix, snapshot_date: '2026-06-13', layout_version: 'immutable_snapshot_v2' };
        const asBuf = (o) => (Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body));
        const bucketShim = {
            async head(key) {
                const o = mock.store.get(key);
                return o ? { size: asBuf(o).length, etag: o.etag } : null;
            },
            async get(key) {
                const o = mock.store.get(key);
                if (!o) return null;
                const body = asBuf(o);
                return {
                    etag: o.etag,
                    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
                };
            },
        };
        const index = await loadTargetIndex(bucketShim, ctx);
        // (12) a KNOWN target resolves -> a legit 404 is NOT a missing index.
        expect(getTargetEntry(index, 'P23219')).not.toBeNull();
        expect(getTargetEntry(index, 'P99999')).toBeNull(); // genuine not-found, index present
    }, HEAVY_MS);

    it('(7) a satellite written to the WRONG prefix is REJECTED by the V3-A write-GUARD', async () => {
        const { assertCandidateKey } = await import('../../scripts/verify/rk15-v3-lib.js');
        const prefix = 'snapshots/2026-06-13/7000-1/';
        // A papers satellite under a DIFFERENT prefix -> guard throws (cannot leak).
        expect(() => assertCandidateKey('snapshots/2026-06-13/9999-1/papers.jsonl.gz', prefix)).toThrow(/outside the candidate prefix/i);
        expect(() => assertCandidateKey(`${prefix}papers.jsonl.gz`, prefix)).not.toThrow();
    });

    it('(12-guard) the active KNOWN-BAD candidate prefix is NEVER written', async () => {
        const mock = makeR2Mock();
        seedSource(mock); seedProdLatest(mock);
        const ACTIVE_BAD = 'snapshots/2026-06-13/27467183738-1/';
        const r = await runV3A({ client: mock, bucket: 'b', ...RUN });
        expect(r.a_pass).toBe(true);
        // No write landed under the known-bad active candidate prefix.
        for (const key of mock.store.keys()) {
            expect(key.startsWith(ACTIVE_BAD), `wrote under active known-bad prefix: ${key}`).toBe(false);
        }
        // And production latest is untouched.
        expect(JSON.parse(mock.store.get(PROD_LATEST_KEY).body).latest_snapshot_date).toBe('2026-06-01');
    }, HEAVY_MS);
});
