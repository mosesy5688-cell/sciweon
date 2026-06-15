// @ts-nocheck
/**
 * RK-16C FULL-CORPUS SPIKE (I) — STRICT read-only adapter + identity + lock.
 * Asserts SAFE BY DEFAULT + the M1-M4 corrections. OFFLINE (mock S3 client).
 */
import { describe, it, expect } from 'vitest';
import {
    computeDryRunPlan, preflightManifest, executeFullRun, redact, atomicMaterialize,
    cleanup, MAX_REQUESTS, MAX_OBJECTS, MAX_TOTAL_BYTES, materializationDir,
} from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import {
    proposeIdentity, validateIdentity, reconcileLatestVsPin, consumedObjectKeys,
    bioactivitiesObjectKey, manifestObjectKey, FORBIDDEN_LATEST_ALIAS_KEY,
    CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    validateLock, requireLock, LOCK_SCHEMA_VERSION, REQUIRED_LOCK_FIELDS,
} from '../../scripts/spikes/rk16c/lib/fullcorpus-lock.mjs';
import { diskPreflight, tempDiskFormula } from '../../scripts/spikes/rk16c/lib/resource-guard.mjs';
import { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import fs from 'fs'; import os from 'os'; import path from 'path';

const MANIFEST = manifestObjectKey(CANDIDATE_SNAPSHOT_ID);
const PAYLOAD = bioactivitiesObjectKey(CANDIDATE_SNAPSHOT_ID);
describe('M1 — snapshots/latest.json is NOT in any read path', () => {
    it('consumed keys = exactly [manifest, payload]; latest absent', () => {
        expect(consumedObjectKeys(CANDIDATE_SNAPSHOT_ID)).toEqual([MANIFEST, PAYLOAD]);
        expect(consumedObjectKeys(CANDIDATE_SNAPSHOT_ID)).not.toContain(FORBIDDEN_LATEST_ALIAS_KEY);
        expect(FORBIDDEN_LATEST_ALIAS_KEY).toBe('snapshots/latest.json'); // export-only, never read
    });
    it('dry-run plan emits ONLY the 2 keys, no latest, no network', () => {
        const plan = computeDryRunPlan({});
        expect(plan.network_performed).toBe(false);
        expect(plan.proposed_object_keys).toEqual([MANIFEST, PAYLOAD]);
        expect(plan.allowlist).toEqual([MANIFEST, PAYLOAD]);
        expect(JSON.stringify([plan.proposed_object_keys, plan.allowlist, plan.identity_envelope.consumed_object_keys])).not.toContain('latest.json');
        expect(plan.forbidden_keys).toContain('snapshots/latest.json');
        expect(plan.estimated_request_count).toBe(4); // 2 keys x (HEAD+GET)
        expect(plan.estimated_object_count).toBe(2);
        expect(plan.within_caps).toBe(true);
        expect(plan.identity_envelope.sha256).toBeNull();
    });
});
describe('M2 — stricter exact read-only guard', () => {
    function mock() { return { send: async () => ({ ETag: '"e"', ContentLength: 1, Body: 'x' }) }; }
    it('REJECTS a ListObjectsV2 command (throws)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, PAYLOAD]);
        await expect(g.send(new ListObjectsV2Command({ Bucket: 'b', Prefix: 'snapshots/' })))
            .rejects.toThrow(/LIST\/discovery/);
        expect(g.list_attempt_count).toBe(1);
    });
    it('REJECTS a HEAD/GET of a non-allowlisted key (incl. latest)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, PAYLOAD]);
        await expect(g.send(new GetObjectCommand({ Bucket: 'b', Key: 'snapshots/latest.json' })))
            .rejects.toThrow(/non-allowlisted key/);
        await expect(g.send(new HeadObjectCommand({ Bucket: 'b', Key: 'snapshots/other.json' })))
            .rejects.toThrow(/non-allowlisted key/);
        expect(g.non_allowlisted_key_attempt_count).toBe(2);
    });
    it('PASSES a HEAD/GET of an allowlisted key (mock)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, PAYLOAD]);
        await expect(g.send(new HeadObjectCommand({ Bucket: 'b', Key: MANIFEST }))).resolves.toBeTruthy();
        await expect(g.send(new GetObjectCommand({ Bucket: 'b', Key: PAYLOAD }))).resolves.toBeTruthy();
        expect(g.readCounts).toEqual({ list: 0, head: 1, get: 1 });
    });
    it('REJECTS any PUT (no write reaches the store)', async () => {
        const g = instrumentExactReadOnlyClient(mock(), [MANIFEST, PAYLOAD]);
        await expect(g.send(new PutObjectCommand({ Bucket: 'b', Key: MANIFEST, Body: 'x' })))
            .rejects.toThrow(/EXACT READ-ONLY GUARD/);
        expect(g.put_count).toBe(1);
        expect(g.write_attempt_count).toBe(1);
    });
});

describe('M3 — versioned credential-free lock + fail-before-network', () => {
    function completeLock() {
        return {
            schema_version: LOCK_SCHEMA_VERSION, snapshot_id: CANDIDATE_SNAPSHOT_ID,
            production_run_id: '27502029137-1', manifest_key: MANIFEST, manifest_etag: '"m"',
            manifest_byte_size: 1024, manifest_sha256: 'a'.repeat(64), payload_key: PAYLOAD,
            payload_etag: '"p"', payload_byte_size: 60 * 1024 * 1024,
            payload_sha256: 'b'.repeat(64), expected_row_count: EXPECTED_ROW_COUNT,
        };
    }
    it('a complete lock passes validation', () => {
        const r = validateLock(completeLock());
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
        expect(REQUIRED_LOCK_FIELDS.length).toBe(12);
    });
    it('require() throws listing every missing pin', () => {
        const bad = completeLock(); bad.payload_sha256 = null; bad.payload_etag = '';
        expect(() => requireLock(bad)).toThrow(/payload_sha256[\s\S]*payload_etag|payload_etag[\s\S]*payload_sha256/);
        expect(() => requireLock(bad)).toThrow(/FAIL BEFORE NETWORK/);
    });
    it('rejects a credential-shaped field (credential-free lock)', () => {
        const bad = completeLock(); bad.secret_access_key = 'x';
        expect(validateLock(bad).ok).toBe(false);
    });
    it('full run require()s a complete lock BEFORE any client (fail-before-network)', async () => {
        let clientMade = false;
        const deps = {
            makeClient: () => { clientMade = true; return { send: async () => ({}) }; },
            instrument: instrumentExactReadOnlyClient,
            headObject: async () => { throw new Error('HEAD must not be reached'); },
            getObject: async () => { throw new Error('GET must not be reached'); }, bucket: 'b',
        };
        // missing lock, then incomplete lock file -> both fail BEFORE any client.
        await expect(executeFullRun({ execute: true }, deps)).rejects.toThrow(/FAIL BEFORE NETWORK/);
        expect(clientMade).toBe(false);
        const lockPath = path.join(os.tmpdir(), `rk16c-test-lock-${process.pid}.json`);
        const incomplete = completeLock(); incomplete.payload_sha256 = null;
        fs.writeFileSync(lockPath, JSON.stringify(incomplete));
        await expect(executeFullRun({ execute: true, lockPath }, deps)).rejects.toThrow(/FAIL BEFORE NETWORK/);
        expect(clientMade).toBe(false);
        fs.unlinkSync(lockPath);
    });
});

describe('M3/M4 — full run consumes lock, verifies pins, streams (no decompressed file)', () => {
    const body = Buffer.from('{"id":"sciweon::bioactivity::1"}\n');
    const sha = createHash('sha256').update(body).digest('hex');
    function lockFile(extra = {}) {
        const lock = {
            schema_version: LOCK_SCHEMA_VERSION, snapshot_id: CANDIDATE_SNAPSHOT_ID,
            production_run_id: '27502029137-1', manifest_key: MANIFEST, manifest_etag: '"m"',
            manifest_byte_size: 1024, manifest_sha256: 'a'.repeat(64), payload_key: PAYLOAD,
            payload_etag: '"p"', payload_byte_size: body.length, payload_sha256: sha,
            expected_row_count: 1, ...extra,
        };
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
        cleanup(CANDIDATE_SNAPSHOT_ID);
        const lockPath = lockFile();
        const res = await executeFullRun({ execute: true, lockPath }, deps());
        expect(res.network_performed).toBe(true);
        expect(res.decompressed_file_written).toBe(false);
        expect(res.put_count).toBe(0);
        expect(res.list_count).toBe(0);
        expect(res.identity_envelope.sha256).toBe(sha);
        expect(res.peak_memory.rss).toBeGreaterThan(0);
        expect(res.peak_memory.external).toBeGreaterThanOrEqual(0);
        // ONLY the compressed .gz landed — no decompressed sibling on disk.
        const dir = materializationDir(CANDIDATE_SNAPSHOT_ID);
        const files = fs.readdirSync(dir);
        expect(files).toContain('bioactivities.jsonl.gz');
        expect(files.some((f) => f.endsWith('.jsonl') && !f.endsWith('.gz'))).toBe(false);
        cleanup(CANDIDATE_SNAPSHOT_ID);
    });
    it('FAIL-CLOSES when payload sha256 != lock pin (file not kept)', async () => {
        cleanup(CANDIDATE_SNAPSHOT_ID);
        const lockPath = lockFile({ payload_sha256: 'f'.repeat(64) });
        await expect(executeFullRun({ execute: true, lockPath }, deps()))
            .rejects.toThrow(/payload sha256 != lock pin/);
        cleanup(CANDIDATE_SNAPSHOT_ID);
    });
});

describe('M3 — metadata-only preflight (manifest key only, payload untouched)', () => {
    function deps(body) {
        return {
            makeClient: () => ({ send: async () => ({}) }), instrument: instrumentExactReadOnlyClient,
            headObject: async () => ({ etag: '"m"', size: body ? body.length : 0 }),
            getObject: async () => ({ etag: '"m"', size: body ? body.length : 0, body }), bucket: 'b',
        };
    }
    it('reads ONLY the manifest under a small byte cap (mock)', async () => {
        const r = await preflightManifest({ execute: true, snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: MANIFEST }, deps(Buffer.from('{"files":[]}')));
        expect(r.mode).toBe('preflight');
        expect(r.manifest_key).toBe(MANIFEST);
        expect(r.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    it('rejects a manifest-key that does not match the snapshot', async () => {
        await expect(preflightManifest({ execute: true, snapshot: CANDIDATE_SNAPSHOT_ID, manifestKey: 'snapshots/latest.json' }, deps()))
            .rejects.toThrow(/manifest-key mismatch/);
    });
});

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
        expect(f.required_free_bytes).toBeGreaterThan(f.subtotal - 1);
    });
    it('atomicMaterialize throws on size mismatch (partial)', () => {
        const dir = materializationDir('TEST_PARTIAL');
        expect(() => atomicMaterialize(dir, 'x.gz', Buffer.from('abc'), 99)).toThrow(/PARTIAL DOWNLOAD/);
        cleanup('TEST_PARTIAL');
        expect(fs.existsSync(dir)).toBe(false);
    });
});

describe('rk16c corpus-identity validator FAIL-CLOSES + never follows latest', () => {
    const pinned = { snapshot_id: CANDIDATE_SNAPSHOT_ID, expected_sha256: 'a'.repeat(64), expected_row_count: EXPECTED_ROW_COUNT };
    function verified() {
        const e = proposeIdentity({});
        e.sha256 = 'a'.repeat(64); e.observed_row_count = EXPECTED_ROW_COUNT;
        e.object_byte_size = 10; e.etag = '"e"'; e.local_materialization_path = '/tmp/x';
        return e;
    }
    it('valid on a match; fails on sha256/row_count/snapshot_id mismatch', () => {
        expect(validateIdentity(verified(), pinned).valid).toBe(true);
        const a = verified(); a.sha256 = 'b'.repeat(64);
        expect(validateIdentity(a, pinned).valid).toBe(false);
        const b = verified(); b.observed_row_count = 1;
        expect(validateIdentity(b, pinned).valid).toBe(false);
        const c = verified(); c.snapshot_id = 'other/1-1';
        const r = validateIdentity(c, pinned);
        expect(r.valid).toBe(false);
        expect(r.errors.join(' ')).toMatch(/NEVER auto-switch to latest/);
    });
    it('never follows latest when latest != pin (no read involved)', () => {
        const rec = reconcileLatestVsPin('2099-01-01/9-1', CANDIDATE_SNAPSHOT_ID);
        expect(rec.matches_pin).toBe(false);
        expect(rec.note).toMatch(/NEVER follows latest/);
    });
});

describe('rk16c redaction + corrected caps', () => {
    it('redacts access keys, secrets, url creds, long tokens', () => {
        const fakeId = 'ZZZ' + '0123456789'.repeat(4);
        const s = redact(`R2_ACCESS_KEY_ID=${fakeId} secret_access_key: abcdefghabcdefghabcdefghabcdefghabcdefgh https://user:pass@host/p`);
        expect(s).not.toContain(fakeId);
        expect(s).toContain('REDACTED');
        expect(s).not.toContain('user:pass@');
    });
    it('caps reflect the corrected 2-object set', () => {
        expect(MAX_REQUESTS).toBeLessThanOrEqual(20);
        expect(MAX_OBJECTS).toBe(2);
        expect(Number.isFinite(MAX_TOTAL_BYTES)).toBe(true);
    });
});
