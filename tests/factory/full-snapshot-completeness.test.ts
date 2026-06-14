// @ts-nocheck
/**
 * RK-15 full-snapshot completeness — validateCandidate fail-loud + complete
 * candidate publish + active-candidate-untouched.
 *
 * The V3-A defect: an INCOMPLETE candidate (no satellites) went VALIDATED + LIVE
 * -> papers/trials/bioactivities/repurposing 503, target 404. These tests prove
 * the COMPLETE-snapshot contract:
 *   - a complete Run#1-shaped candidate -> validateCandidate PASS + every
 *     satellite reader-decodes (gunzip + a sample loader key-derivation);
 *   - missing/empty/wrong-prefix/undeclared/corrupt satellite -> validate FAIL,
 *     latest NOT swapped, candidate not ACTIVATABLE;
 *   - the seal declares the COMPLETE inventory; a seal-inventory<->object
 *     mismatch FAILs;
 *   - the active (known-bad) candidate prefix is NEVER written.
 *
 * Against a mock S3 client emulating R2 conditional PUTs (true R2 honoring is
 * confirmed live by the workflow).
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import {
    buildAndSealCandidate, validateCandidate, activateValidatedCandidate,
} from '../../scripts/factory/lib/stage-4-activate.js';
import { requiredSatelliteKeys, SATELLITE_INVENTORY } from '../../scripts/factory/lib/snapshot-inventory.js';
import { searchProjectionKey, xrefIndexKey, putCreateOnly } from '../../scripts/factory/lib/snapshot-identity.js';
import { makeClient, publishCandidate, LATEST_KEY } from './helpers/pr-b-activate-fixtures';
import { runV3A } from '../../scripts/verify/rk15-v3-candidate.js';
import { makeR2Mock, seedSource, seedProdLatest, buildSourceBuffers, PROD_LATEST_KEY } from './helpers/rk15-v3-fixtures';
import { loadTargetIndex, getTargetEntry } from '../../src/worker/lib/target-loader';

const HEAVY_MS = 60_000;
const RUN = { sourceRunId: '27413864028', date: '2026-06-13', runId: '7000', runAttempt: '1', commitSha: 'sat', targetCid: 2244 };

/** Reader-decodable satellite bodies keyed by suffix (gunzip + a parseable line). */
function satelliteBodies() {
    const m = {};
    for (const e of SATELLITE_INVENTORY) {
        m[e.key_suffix] = gzipSync(Buffer.from(JSON.stringify({ ok: true, file: e.snapshot_file }) + '\n', 'utf-8'), { level: 9 });
    }
    return m;
}

/** Publish a COMPLETE candidate (compound + xref + search + ALL satellites) into
 * `client` and seal it. Returns { identity, manifest, prefix, manifestHash, satelliteKeys }. */
async function publishComplete(client, date, runId, overrideBodies = null) {
    const { identity, manifest, prefix } = await publishCandidate(client, date, runId);
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

    it('(8) seal declares a satellite key the store does NOT have -> FAIL (seal<->objects inconsistent)', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-13', '910');
        // Seal declares the COMPLETE satellite set, but we publish NONE of them.
        const satelliteKeys = requiredSatelliteKeys(prefix);
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest,
            negManifestKey: null, hasXref: true, hasSearch: true, satelliteKeys,
        });
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).rejects.toThrow(/satellite object missing/i);
    });

    it('(8b) a sealed satellite key that is NOT a known serving surface -> FAIL', async () => {
        const client = makeClient();
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-13', '911');
        const bogus = `${prefix}phantom.jsonl.gz`;
        await putCreateOnly(client, 'b', bogus, gzipSync(Buffer.from('{"x":1}\n')), 'application/gzip');
        const { manifestHash } = await buildAndSealCandidate({
            client, bucket: 'b', identity, compoundManifest: manifest,
            negManifestKey: null, hasXref: true, hasSearch: true, satelliteKeys: [bogus],
        });
        await expect(
            validateCandidate({ client, bucket: 'b', identity, expectedHash: manifestHash }),
        ).rejects.toThrow(/not a known serving surface/i);
    });

    it('(11) an INCOMPLETE candidate never reaches ACTIVATABLE -> latest UNCHANGED', async () => {
        const client = makeClient();
        // Publish compound + xref + search + satellites, but do NOT pre-seal:
        // activateValidatedCandidate seals + validates + swaps. Then drop a
        // satellite so the validate step (inside activate) fails BEFORE any swap.
        const { identity, manifest, prefix } = await publishCandidate(client, '2026-06-13', '912');
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
