// @ts-nocheck
/**
 * RK-16C FULL-CORPUS SPIKE — STRICT read-only adapter + identity + lock v2 (D-103
 * A1 two-manifest). Asserts SAFE BY DEFAULT + the M1-M4 corrections + the A1
 * trust-anchor lock. OFFLINE (mock S3 client).
 */
import { describe, it, expect } from 'vitest';
import {
    computeDryRunPlan, preflightManifest, executeFullRun, redact, atomicMaterialize,
    cleanup, MAX_REQUESTS, MAX_OBJECTS, MAX_TOTAL_BYTES, MAX_METADATA_TOTAL_BYTES,
    materializationDir,
} from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import {
    proposeIdentity, validateIdentity, reconcileLatestVsPin, consumedObjectKeys,
    bioactivitiesObjectKey, manifestObjectKey, fileManifestObjectKey, objectPrefixOf,
    FORBIDDEN_LATEST_ALIAS_KEY, CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    validateLock, requireLock, LOCK_SCHEMA_VERSION, TRUST_ANCHOR_MODE, REQUIRED_LOCK_FIELDS,
} from '../../scripts/spikes/rk16c/lib/fullcorpus-lock.mjs';
import { diskPreflight, tempDiskFormula } from '../../scripts/spikes/rk16c/lib/resource-guard.mjs';
import { canonicalManifestHash } from '../../scripts/factory/lib/snapshot-identity.js';
import { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import fs from 'fs'; import os from 'os'; import path from 'path';

const SNAP = CANDIDATE_SNAPSHOT_ID;
const PREFIX = objectPrefixOf(SNAP);
const MANIFEST = manifestObjectKey(SNAP); // root seal
const FILE_KEY = fileManifestObjectKey(SNAP);
const PAYLOAD = bioactivitiesObjectKey(SNAP);
const BIO = 'bioactivities.jsonl.gz';

function completeLock(extra = {}) {
    return {
        candidate_lock_schema: LOCK_SCHEMA_VERSION,
        trust_anchor_mode: TRUST_ANCHOR_MODE,
        root_directly_references_file_manifest: false,
        file_manifest_key_derivation: 'validated_object_prefix + "manifest.json"',
        payload_membership_anchor: 'root satellite_inventory',
        file_manifest_admissibility_anchor: 'deterministic sibling key + immutable create-only producer contract + inventory reconciliation',
        root_manifest_key: MANIFEST, root_manifest_etag: '"m"', root_manifest_byte_size: 1024,
        root_manifest_sha256: 'a'.repeat(64), root_manifest_stored_hash: 'a'.repeat(64), root_manifest_recomputed_hash: 'a'.repeat(64),
        file_manifest_key: FILE_KEY, file_manifest_etag: '"f"', file_manifest_byte_size: 512,
        file_manifest_sha256: 'd'.repeat(64), file_manifest_schema_version: 1,
        payload_key: PAYLOAD, payload_filename: BIO, payload_sha256_compressed: 'b'.repeat(64),
        payload_compressed_bytes: 60 * 1024 * 1024, expected_row_count: EXPECTED_ROW_COUNT,
        snapshot_id: SNAP, production_run_id: '27502029137-1', producer_contract_version: 'snapshot-schema-v1',
        ...extra,
    };
}

describe('M1 — snapshots/latest.json is NOT in any read path', () => {
    it('consumed keys = exactly [seal, payload]; latest absent', () => {
        expect(consumedObjectKeys(SNAP)).toEqual([MANIFEST, PAYLOAD]);
        expect(consumedObjectKeys(SNAP)).not.toContain(FORBIDDEN_LATEST_ALIAS_KEY);
        expect(FORBIDDEN_LATEST_ALIAS_KEY).toBe('snapshots/latest.json');
    });
    it('dry-run plan emits the keys with no latest, no network', () => {
        const plan = computeDryRunPlan({});
        expect(plan.network_performed).toBe(false);
        expect(JSON.stringify([plan.proposed_object_keys, plan.allowlist])).not.toContain('latest.json');
        expect(plan.forbidden_keys).toContain('snapshots/latest.json');
        expect(plan.within_caps).toBe(true);
        expect(plan.identity_envelope.sha256).toBeNull();
    });
});

describe('M2 — stricter exact read-only guard', () => {
    function mock() { return { send: async () => ({ ETag: '"e"', ContentLength: 1, Body: 'x' }) }; }
    it('REJECTS a ListObjectsV2 command (throws)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, FILE_KEY]);
        await expect(g.send(new ListObjectsV2Command({ Bucket: 'b', Prefix: 'snapshots/' }))).rejects.toThrow(/LIST\/discovery/);
        expect(g.list_attempt_count).toBe(1);
    });
    it('REJECTS a HEAD/GET of a non-allowlisted key (incl. latest + payload)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, FILE_KEY]);
        await expect(g.send(new GetObjectCommand({ Bucket: 'b', Key: 'snapshots/latest.json' }))).rejects.toThrow(/non-allowlisted key/);
        await expect(g.send(new HeadObjectCommand({ Bucket: 'b', Key: PAYLOAD }))).rejects.toThrow(/non-allowlisted key/);
        expect(g.non_allowlisted_key_attempt_count).toBe(2);
    });
    it('PASSES a HEAD/GET of an allowlisted key (mock)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, FILE_KEY]);
        await expect(g.send(new HeadObjectCommand({ Bucket: 'b', Key: MANIFEST }))).resolves.toBeTruthy();
        await expect(g.send(new GetObjectCommand({ Bucket: 'b', Key: FILE_KEY }))).resolves.toBeTruthy();
        expect(g.readCounts).toEqual({ list: 0, head: 1, get: 1 });
    });
    it('REJECTS any PUT (no write reaches the store)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, FILE_KEY]);
        await expect(g.send(new PutObjectCommand({ Bucket: 'b', Key: MANIFEST, Body: 'x' }))).rejects.toThrow(/EXACT READ-ONLY GUARD/);
        expect(g.put_count).toBe(1); expect(g.write_attempt_count).toBe(1);
    });
});

describe('M3 — versioned credential-free lock v2 + fail-before-network', () => {
    it('a complete v2 lock passes validation (24 required integrity/identity fields)', () => {
        const r = validateLock(completeLock());
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
        expect(REQUIRED_LOCK_FIELDS.length).toBe(24);
    });
    it('require() throws listing every missing pin', () => {
        const bad = completeLock(); bad.payload_sha256_compressed = null; bad.payload_compressed_bytes = null;
        expect(() => requireLock(bad)).toThrow(/payload_sha256_compressed[\s\S]*payload_compressed_bytes|payload_compressed_bytes[\s\S]*payload_sha256_compressed/);
        expect(() => requireLock(bad)).toThrow(/FAIL BEFORE NETWORK/);
    });
    it('rejects a lock that claims direct root linkage (root_directly_references_file_manifest != false)', () => {
        expect(validateLock(completeLock({ root_directly_references_file_manifest: true })).ok).toBe(false);
    });
    it('rejects a credential-shaped field (credential-free lock)', () => {
        expect(validateLock(completeLock({ secret_access_key: 'x' })).ok).toBe(false);
    });
    it('full run require()s a complete + AUTHORIZED lock BEFORE any client (fail-before-network)', async () => {
        let clientMade = false;
        const deps = {
            makeClient: () => { clientMade = true; return { send: async () => ({}) }; },
            instrument: instrumentExactReadOnlyClient,
            headObject: async () => { throw new Error('HEAD must not be reached'); },
            getObject: async () => { throw new Error('GET must not be reached'); }, bucket: 'b',
        };
        await expect(executeFullRun({ execute: true }, deps)).rejects.toThrow(/FAIL BEFORE NETWORK/);
        expect(clientMade).toBe(false);
        const lockPath = path.join(os.tmpdir(), `rk16c-test-lock-${process.pid}.json`);
        const incomplete = completeLock(); incomplete.payload_sha256_compressed = null;
        fs.writeFileSync(lockPath, JSON.stringify(incomplete));
        await expect(executeFullRun({ execute: true, lockPath }, deps)).rejects.toThrow(/FAIL BEFORE NETWORK/);
        expect(clientMade).toBe(false);
        // a COMPLETE but UNAUTHORIZED lock also fails before network.
        fs.writeFileSync(lockPath, JSON.stringify(completeLock())); // authorized_for_payload_read absent
        await expect(executeFullRun({ execute: true, lockPath }, deps)).rejects.toThrow(/not founder-authorized|FAIL BEFORE NETWORK/);
        expect(clientMade).toBe(false);
        fs.unlinkSync(lockPath);
    });
});

describe('M3/M4 — full run consumes AUTHORIZED lock, verifies pins, streams (no decompressed file)', () => {
    const body = Buffer.from('{"id":"sciweon::bioactivity::1"}\n');
    const sha = createHash('sha256').update(body).digest('hex');
    function lockFile(extra = {}) {
        const lock = completeLock({ payload_compressed_bytes: body.length, payload_sha256_compressed: sha, expected_row_count: 1, authorized_for_payload_read: true, ...extra });
        const p = path.join(os.tmpdir(), `rk16c-test-lock-ok-${process.pid}-${Date.now()}-${Math.random()}.json`);
        fs.writeFileSync(p, JSON.stringify(lock));
        return p;
    }
    function deps() {
        return {
            makeClient: () => ({ send: async () => ({}) }), instrument: instrumentExactReadOnlyClient,
            headObject: async () => ({ etag: '"p"', size: body.length }),
            getObject: async () => ({ etag: '"p"', size: body.length, body }), bucket: 'bkt',
        };
    }
    it('M4 — writes NO decompressed file + records peak process memory', async () => {
        cleanup(SNAP);
        const res = await executeFullRun({ execute: true, lockPath: lockFile() }, deps());
        expect(res.network_performed).toBe(true);
        expect(res.decompressed_file_written).toBe(false);
        expect(res.put_count).toBe(0); expect(res.list_count).toBe(0);
        expect(res.identity_envelope.sha256).toBe(sha);
        expect(res.peak_memory.rss).toBeGreaterThan(0);
        const dir = materializationDir(SNAP);
        const files = fs.readdirSync(dir);
        expect(files).toContain('bioactivities.jsonl.gz');
        expect(files.some((f) => f.endsWith('.jsonl') && !f.endsWith('.gz'))).toBe(false);
        cleanup(SNAP);
    });
    it('FAIL-CLOSES when payload sha256 != lock pin (file not kept)', async () => {
        cleanup(SNAP);
        await expect(executeFullRun({ execute: true, lockPath: lockFile({ payload_sha256_compressed: 'f'.repeat(64) }) }, deps()))
            .rejects.toThrow(/payload sha256 != lock pin/);
        cleanup(SNAP);
    });
});

// NOTE: two-manifest preflightManifest behaviour (seal+manifest.json reads, byte
// caps, candidate assembly, manifest-key mismatch) is covered exhaustively by
// tests/rk16/rk16c-two-manifest.test.ts.

describe('M4 — disk free-space preflight + partial-download', () => {
    it('fails-before-network on an impossible required free size', () => {
        const r = diskPreflight(os.tmpdir(), { compressedBytes: 1e18 });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/insufficient|UNKNOWN/);
    });
    it('temp-disk formula has a streamed (zero) decompressed term', () => {
        const f = tempDiskFormula({ compressedBytes: 60 * 1024 * 1024 });
        expect(f.terms.decompressed_materialization).toBe(0);
        expect(f.decompressed_path).toMatch(/STREAMED/);
    });
    it('atomicMaterialize throws on size mismatch (partial)', () => {
        const dir = materializationDir('TEST_PARTIAL');
        expect(() => atomicMaterialize(dir, 'x.gz', Buffer.from('abc'), 99)).toThrow(/PARTIAL DOWNLOAD/);
        cleanup('TEST_PARTIAL');
        expect(fs.existsSync(dir)).toBe(false);
    });
});

describe('rk16c corpus-identity validator FAIL-CLOSES + never follows latest', () => {
    const pinned = { snapshot_id: SNAP, expected_sha256: 'a'.repeat(64), expected_row_count: EXPECTED_ROW_COUNT };
    function verified() {
        const e = proposeIdentity({});
        e.sha256 = 'a'.repeat(64); e.observed_row_count = EXPECTED_ROW_COUNT;
        e.object_byte_size = 10; e.etag = '"e"'; e.local_materialization_path = '/tmp/x';
        return e;
    }
    it('valid on a match; fails on sha256/row_count/snapshot_id mismatch', () => {
        expect(validateIdentity(verified(), pinned).valid).toBe(true);
        const c = verified(); c.snapshot_id = 'other/1-1';
        expect(validateIdentity(c, pinned).errors.join(' ')).toMatch(/NEVER auto-switch to latest/);
    });
    it('never follows latest when latest != pin (no read involved)', () => {
        expect(reconcileLatestVsPin('2099-01-01/9-1', SNAP).note).toMatch(/NEVER follows latest/);
    });
});

describe('rk16c redaction + corrected caps', () => {
    it('redacts access keys, secrets, url creds, long tokens', () => {
        const fakeId = 'ZZZ' + '0123456789'.repeat(4);
        const s = redact(`R2_ACCESS_KEY_ID=${fakeId} secret_access_key: abcdefghabcdefghabcdefghabcdefghabcdefgh https://user:pass@host/p`);
        expect(s).not.toContain(fakeId); expect(s).toContain('REDACTED'); expect(s).not.toContain('user:pass@');
    });
    it('caps reflect the 2-object metadata set', () => {
        expect(MAX_REQUESTS).toBeLessThanOrEqual(20);
        expect(MAX_OBJECTS).toBe(2);
        expect(Number.isFinite(MAX_TOTAL_BYTES)).toBe(true);
    });
});
