// @ts-nocheck
/**
 * RK-16C FULL-CORPUS RUNNER — D-103 A1 two-manifest wiring tests. FAKE client
 * only, ZERO network, NEVER makeR2Client, NEVER production R2.
 *
 * Proves: (1) selectAction's exact state matrix; (2) ONLY --preflight --execute
 * reaches the two-manifest preflight (seal + manifest.json — no List, no payload,
 * no other key) and emits an UNRATIFIED candidate with the payload pins; (3)
 * generic --execute fails closed and constructs NO client; (4) incomplete
 * manifest args fail closed BEFORE any client; (5) the runner source does NOT
 * reference the full-run adapter symbol; (6) a per-file manifest without the
 * bioactivities entry fails closed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { canonicalManifestHash } from '../../scripts/factory/lib/snapshot-identity.js';
import { selectAction, runPreflight } from '../../scripts/spikes/rk16c/lib/preflight-control.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    CANDIDATE_SNAPSHOT_ID, manifestObjectKey, fileManifestObjectKey,
    bioactivitiesObjectKey, objectPrefixOf,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '../../scripts/spikes/rk16c/run-fullcorpus.mjs');
const RESULTS = path.resolve(HERE, '../../scripts/spikes/rk16c/results');
const CANDIDATE = path.join(RESULTS, 'RK16C_FULLCORPUS_LOCK.candidate.json');
const SNAP = CANDIDATE_SNAPSHOT_ID;
const PREFIX = objectPrefixOf(SNAP);
const SEAL_KEY = manifestObjectKey(SNAP);
const FILE_KEY = fileManifestObjectKey(SNAP);
const PAYLOAD = bioactivitiesObjectKey(SNAP);
const BIO = 'bioactivities.jsonl.gz';

function sealBody() {
    const sats = [PREFIX + BIO, PREFIX + 'papers.jsonl.gz'];
    const core = {
        layout_version: 'immutable_snapshot_v2', schema_version: 1, snapshot_id: SNAP,
        snapshot_date: '2026-06-14', object_prefix: PREFIX, run_id: '27502029137', run_attempt: '1',
        compound_total_records: 1, compound_shard_hashes: ['x'],
        required_inventory: [PREFIX + 'compounds/bucket-0000/manifest.json', ...sats], satellite_inventory: sats,
    };
    return Buffer.from(JSON.stringify({ ...core, manifest_hash: canonicalManifestHash(core) }));
}
function fileBody({ withBio = true, withPins = true } = {}) {
    const files = [{ filename: 'papers.jsonl.gz', records: 3, compressed_bytes: 9, sha256_compressed: 'c'.repeat(64) }];
    if (withBio) {
        const bio = { filename: BIO, records: 475112 };
        if (withPins) { bio.compressed_bytes = 62914560; bio.sha256_compressed = 'b'.repeat(64); }
        files.push(bio);
    } else {
        // a satellite (papers) still present; bio missing -> reconcile fails on bio satellite
        files.push({ filename: 'extra.jsonl.gz', records: 1, compressed_bytes: 1, sha256_compressed: 'e'.repeat(64) });
    }
    return Buffer.from(JSON.stringify({ snapshot_id: SNAP, object_prefix: PREFIX, schema_version: 1, run_id: '27502029137', files }));
}
function fakeDeps(bodies) {
    const seen = [];
    const client = {
        async send(command) {
            const ctor = command?.constructor?.name; const key = command?.input?.Key ?? null;
            seen.push({ ctor, key });
            const body = bodies[key];
            if (body === undefined) throw new Error(`fake: no body for ${key}`);
            if (ctor === 'HeadObjectCommand') return { ETag: '"e"', ContentLength: body.length };
            return { ETag: '"e"', Body: body };
        },
    };
    const headObject = async (c, b, k) => { const r = await c.send(new HeadObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.ContentLength }; };
    const getObject = async (c, b, k) => { const r = await c.send(new GetObjectCommand({ Bucket: b, Key: k })); return { etag: r.ETag, size: r.Body.length, body: r.Body }; };
    return { seen, deps: { makeClient: () => client, instrument: instrumentExactReadOnlyClient, headObject, getObject, bucket: 'fake-bucket' } };
}

describe('selectAction — exact state matrix (7 rows, decided before any client)', () => {
    it('--cleanup -> cleanup', () => { expect(selectAction({ cleanup: true }).action).toBe('cleanup'); });
    it('no flags -> dry-run-matrix (zero network)', () => { expect(selectAction({ execute: false, preflight: false }).action).toBe('dry-run-matrix'); });
    it('--preflight without --execute -> preflight-plan', () => { expect(selectAction({ preflight: true, execute: false }).action).toBe('preflight-plan'); });
    it('--preflight --execute with exact --manifest-key -> preflight-execute', () => {
        expect(selectAction({ preflight: true, execute: true, snapshot: SNAP, manifestKey: SEAL_KEY }).action).toBe('preflight-execute');
    });
    it('--preflight --execute with WRONG/missing --manifest-key -> fail-closed', () => {
        expect(selectAction({ preflight: true, execute: true, snapshot: SNAP }).action).toBe('fail-closed');
        expect(selectAction({ preflight: true, execute: true, snapshot: SNAP, manifestKey: 'snapshots/latest.json' }).action).toBe('fail-closed');
    });
    it('--execute WITHOUT --preflight -> execute-refused', () => { expect(selectAction({ execute: true, preflight: false }).action).toBe('execute-refused'); });
    it('--execute --lock (no --preflight) -> execute-refused', () => { expect(selectAction({ execute: true, preflight: false, lockPath: '/x/lock.json' }).action).toBe('execute-refused'); });
});

describe('runPreflight — two metadata reads only; UNRATIFIED candidate with payload pins', () => {
    it('reads ONLY seal + manifest.json (no List, no payload, no other key)', async () => {
        if (fs.existsSync(CANDIDATE)) fs.unlinkSync(CANDIDATE);
        const { seen, deps } = fakeDeps({ [SEAL_KEY]: sealBody(), [FILE_KEY]: fileBody() });
        const { candidate } = await runPreflight({ snapshot: SNAP, manifestKey: SEAL_KEY, expectedRows: 475112 }, deps);

        expect(seen).toEqual([
            { ctor: 'HeadObjectCommand', key: SEAL_KEY },
            { ctor: 'GetObjectCommand', key: SEAL_KEY },
            { ctor: 'HeadObjectCommand', key: FILE_KEY },
            { ctor: 'GetObjectCommand', key: FILE_KEY },
        ]);
        expect(seen.some((s) => s.key === PAYLOAD)).toBe(false);
        expect(seen.some((s) => s.ctor.startsWith('List'))).toBe(false);

        expect(candidate.status).toBe('UNRATIFIED');
        expect(candidate.founder_approved).toBe(false);
        expect(candidate.authorized_for_payload_read).toBe(false);
        expect(candidate.root_directly_references_file_manifest).toBe(false);
        expect(candidate.payload_key).toBe(PAYLOAD);
        expect(candidate.payload_compressed_bytes).toBe(62914560);
        expect(candidate.payload_sha256_compressed).toBe('b'.repeat(64));
        expect(candidate.expected_row_count).toBe(475112);

        const onDisk = JSON.parse(fs.readFileSync(CANDIDATE, 'utf-8'));
        expect(onDisk.status).toBe('UNRATIFIED');
        expect(onDisk.authorized_for_payload_read).toBe(false);
        fs.unlinkSync(CANDIDATE);
    });

    it('fails closed (no candidate) when the bioactivities satellite has no files[] entry', async () => {
        const { deps } = fakeDeps({ [SEAL_KEY]: sealBody(), [FILE_KEY]: fileBody({ withBio: false }) });
        await expect(runPreflight({ snapshot: SNAP, manifestKey: SEAL_KEY }, deps))
            .rejects.toThrow(/no entry in manifest.files|unreconcilable|bioactivities/);
    });

    it('fails closed when the target entry lacks pins', async () => {
        const { deps } = fakeDeps({ [SEAL_KEY]: sealBody(), [FILE_KEY]: fileBody({ withPins: false }) });
        await expect(runPreflight({ snapshot: SNAP, manifestKey: SEAL_KEY }, deps))
            .rejects.toThrow(/sha256_compressed invalid|compressed_bytes invalid/);
    });
});

describe('fail-closed paths construct NO client', () => {
    function throwingDeps() {
        return {
            makeClient: () => { throw new Error('makeClient MUST NOT be called'); },
            instrument: instrumentExactReadOnlyClient,
            headObject: async () => { throw new Error('HEAD MUST NOT be reached'); },
            getObject: async () => { throw new Error('GET MUST NOT be reached'); },
            bucket: 'x',
        };
    }
    it('generic --execute (no --preflight) is refused by selectAction', () => {
        expect(selectAction({ execute: true, preflight: false }).action).toBe('execute-refused');
    });
    it('incomplete manifest args fail-closed via selectAction BEFORE any client', () => {
        expect(selectAction({ preflight: true, execute: true, snapshot: SNAP, manifestKey: '' }).action).toBe('fail-closed');
    });
    it('runPreflight with a mismatched manifest-key throws BEFORE any client read', async () => {
        await expect(runPreflight({ snapshot: SNAP, manifestKey: 'snapshots/latest.json' }, throwingDeps()))
            .rejects.toThrow(/manifest-key mismatch/);
    });
});

describe('static safety — runner does NOT reference the full-run adapter symbol', () => {
    it('run-fullcorpus.mjs source contains no "executeFullRun"', () => {
        const src = fs.readFileSync(RUNNER, 'utf-8');
        expect(src).not.toContain('executeFullRun');
    });
});
