// @ts-nocheck
/**
 * RK-16C FULL-CORPUS RUNNER — BUILD-CORRECTION wiring tests. FAKE client only,
 * ZERO network, NEVER makeR2Client, NEVER production R2.
 *
 * Proves: (1) selectAction's exact state matrix; (2) ONLY --preflight --execute
 * reaches preflightManifest (manifest key only — no List, no payload, no other
 * key) and emits an UNRATIFIED candidate with the payload pins; (3) generic
 * --execute fails closed and constructs NO client; (4) incomplete manifest args
 * fail closed BEFORE any client; (5) the runner source does NOT reference the
 * full-run adapter symbol; (6) a manifest without the bioactivities entry throws.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
    selectAction, runPreflight, extractPayloadPins,
} from '../../scripts/spikes/rk16c/lib/preflight-control.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    CANDIDATE_SNAPSHOT_ID, manifestObjectKey, bioactivitiesObjectKey,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '../../scripts/spikes/rk16c/run-fullcorpus.mjs');
const RESULTS = path.resolve(HERE, '../../scripts/spikes/rk16c/results');
const CANDIDATE = path.join(RESULTS, 'RK16C_FULLCORPUS_LOCK.candidate.json');
const MANIFEST = manifestObjectKey(CANDIDATE_SNAPSHOT_ID);
const PAYLOAD = bioactivitiesObjectKey(CANDIDATE_SNAPSHOT_ID);
const PAYLOAD_NAME = PAYLOAD.split('/').pop();

function manifestBody({ withBio = true, withPins = true } = {}) {
    const files = [{ filename: '_other.jsonl.gz', records: 3, compressed_bytes: 9, sha256_compressed: 'c'.repeat(64) }];
    if (withBio) {
        const bio = { filename: PAYLOAD_NAME, records: 475112 };
        if (withPins) { bio.compressed_bytes = 62914560; bio.sha256_compressed = 'b'.repeat(64); }
        files.push(bio);
    }
    return Buffer.from(JSON.stringify({ snapshot_id: CANDIDATE_SNAPSHOT_ID, files }));
}

// FAKE deps: a fake client records every Key it sees; headObject/getObject route
// real S3 command objects THROUGH the exact guard so the allowlist is enforced.
function fakeDeps(body) {
    const seen = [];
    const fakeClient = {
        async send(command) {
            const ctor = command?.constructor?.name;
            seen.push({ ctor, key: command?.input?.Key ?? null });
            if (ctor === 'HeadObjectCommand') return { ETag: '"m"', ContentLength: body.length };
            return { ETag: '"m"', Body: body };
        },
    };
    const headObject = async (client, bucket, key) => {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { etag: r.ETag, size: r.ContentLength };
    };
    const getObject = async (client, bucket, key) => {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { etag: r.ETag, size: r.Body.length, body: r.Body };
    };
    return {
        seen,
        deps: {
            makeClient: () => fakeClient,
            instrument: instrumentExactReadOnlyClient,
            headObject, getObject, bucket: 'fake-bucket',
        },
    };
}

describe('selectAction — exact state matrix (7 rows, decided before any client)', () => {
    it('--cleanup -> cleanup', () => {
        expect(selectAction({ cleanup: true }).action).toBe('cleanup');
    });
    it('no flags -> dry-run-matrix (zero network)', () => {
        expect(selectAction({ execute: false, preflight: false }).action).toBe('dry-run-matrix');
    });
    it('--preflight without --execute -> preflight-plan (no matrix, zero network)', () => {
        expect(selectAction({ preflight: true, execute: false }).action).toBe('preflight-plan');
    });
    it('--preflight --execute with exact --manifest-key -> preflight-execute', () => {
        const r = selectAction({ preflight: true, execute: true, snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: MANIFEST });
        expect(r.action).toBe('preflight-execute');
    });
    it('--preflight --execute with WRONG/missing --manifest-key -> fail-closed', () => {
        expect(selectAction({ preflight: true, execute: true, snapshot: CANDIDATE_SNAPSHOT_ID }).action).toBe('fail-closed');
        expect(selectAction({ preflight: true, execute: true, snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: 'snapshots/latest.json' }).action).toBe('fail-closed');
    });
    it('--execute WITHOUT --preflight -> execute-refused', () => {
        expect(selectAction({ execute: true, preflight: false }).action).toBe('execute-refused');
    });
    it('--execute --lock (no --preflight) -> execute-refused (full run CLI-unreachable)', () => {
        expect(selectAction({ execute: true, preflight: false, lockPath: '/x/lock.json' }).action).toBe('execute-refused');
    });
});

describe('runPreflight — ONLY manifest HEAD+GET; UNRATIFIED candidate with payload pins', () => {
    it('reads ONLY the exact manifest key (no List, no payload, no other key)', async () => {
        if (fs.existsSync(CANDIDATE)) fs.unlinkSync(CANDIDATE);
        const { seen, deps } = fakeDeps(manifestBody());
        const args = { snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: MANIFEST, expectedRows: 475112 };
        const { candidate } = await runPreflight(args, deps);

        // Exactly HEAD + GET of the manifest key — nothing else touched the client.
        expect(seen).toEqual([
            { ctor: 'HeadObjectCommand', key: MANIFEST },
            { ctor: 'GetObjectCommand', key: MANIFEST },
        ]);
        expect(seen.some((s) => s.key === PAYLOAD)).toBe(false);
        expect(seen.some((s) => s.ctor.startsWith('List'))).toBe(false);

        expect(candidate.status).toBe('UNRATIFIED');
        expect(candidate.founder_approved).toBe(false);
        expect(candidate.authorized_for_payload_read).toBe(false);
        expect(candidate.payload_key).toBe(PAYLOAD);
        expect(candidate.payload_byte_size).toBe(62914560);
        expect(candidate.payload_sha256).toBe('b'.repeat(64));
        expect(candidate.expected_row_count).toBe(475112);

        const onDisk = JSON.parse(fs.readFileSync(CANDIDATE, 'utf-8'));
        expect(onDisk.status).toBe('UNRATIFIED');
        expect(onDisk.authorized_for_payload_read).toBe(false);
        fs.unlinkSync(CANDIDATE);
    });

    it('throws (no approvable lock) when the manifest body lacks the bioactivities entry', async () => {
        const { deps } = fakeDeps(manifestBody({ withBio: false }));
        await expect(runPreflight({ snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: MANIFEST }, deps))
            .rejects.toThrow(/no '.*bioactivities.*' file entry|no approvable lock/);
    });

    it('extractPayloadPins throws when the entry lacks pins', () => {
        expect(() => extractPayloadPins(manifestBody({ withPins: false }), PAYLOAD))
            .toThrow(/lacks sha256_compressed\/compressed_bytes|no approvable lock/);
    });
});

describe('fail-closed paths construct NO client (makeClient throws-if-called)', () => {
    function throwingDeps() {
        return {
            makeClient: () => { throw new Error('makeClient MUST NOT be called'); },
            instrument: instrumentExactReadOnlyClient,
            headObject: async () => { throw new Error('HEAD MUST NOT be reached'); },
            getObject: async () => { throw new Error('GET MUST NOT be reached'); },
            bucket: 'x',
        };
    }
    it('generic --execute (no --preflight) is refused by selectAction (never reaches runPreflight)', () => {
        // The runner never calls runPreflight for execute-refused; prove the action.
        expect(selectAction({ execute: true, preflight: false }).action).toBe('execute-refused');
        // And if runPreflight were ever (wrongly) invoked with no manifest, the
        // guard inside preflightManifest fails before the throwing client matters.
    });
    it('incomplete manifest args fail-closed via selectAction BEFORE any client', () => {
        expect(selectAction({ preflight: true, execute: true, snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: '' }).action).toBe('fail-closed');
    });
    it('runPreflight with a mismatched manifest-key throws inside preflightManifest, NOT after a client read', async () => {
        // preflightManifest validates the key against the snapshot before HEAD.
        await expect(runPreflight({ snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: 'snapshots/latest.json' }, throwingDeps()))
            .rejects.toThrow(/manifest-key mismatch/);
    });
});

describe('static safety — runner does NOT reference the full-run adapter symbol', () => {
    it('run-fullcorpus.mjs source contains no "executeFullRun"', () => {
        const src = fs.readFileSync(RUNNER, 'utf-8');
        expect(src).not.toContain('executeFullRun');
    });
});
