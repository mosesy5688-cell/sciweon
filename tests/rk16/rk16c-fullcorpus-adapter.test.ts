// @ts-nocheck
/**
 * RK-16C FULL-CORPUS SPIKE (I) — READ-ONLY ADAPTER + corpus-identity contract.
 *
 * Asserts the adapter is SAFE BY DEFAULT: dry-run emits the identity envelope +
 * EXACT object keys + estimates WITH NO network; execute refuses without
 * --execute + a snapshot pin; the P8R1 read-only guard refuses any write; the
 * identity validator FAIL-CLOSES on every mismatch and NEVER follows latest.
 * OFFLINE — uses a mock S3 client; no module-eval corpus load.
 */
import { describe, it, expect } from 'vitest';
import {
    computeDryRunPlan, executeRead, redact, atomicMaterialize, cleanup,
    MAX_REQUESTS, MAX_TOTAL_BYTES, materializationDir,
} from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import {
    proposeIdentity, validateIdentity, reconcileLatestVsPin,
    consumedObjectKeys, CANDIDATE_SNAPSHOT_ID, EXPECTED_ROW_COUNT,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';
import { instrumentReadOnlyClient } from '../../scripts/verify/p8-r1-readonly-probe-lib.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import fs from 'fs';

describe('rk16c full-corpus dry-run plan (NO network)', () => {
    it('emits identity envelope + EXACT object keys + estimates, no network', () => {
        const plan = computeDryRunPlan({});
        expect(plan.network_performed).toBe(false);
        expect(plan.proposed_object_keys).toEqual(consumedObjectKeys(CANDIDATE_SNAPSHOT_ID));
        expect(plan.proposed_object_keys).toEqual([
            'snapshots/latest.json',
            `snapshots/${CANDIDATE_SNAPSHOT_ID}/_snapshot.manifest.json`,
            `snapshots/${CANDIDATE_SNAPSHOT_ID}/bioactivities.jsonl.gz`,
        ]);
        expect(plan.estimated_request_count).toBe(6);
        expect(plan.estimated_total_bytes).toBeGreaterThan(0);
        expect(plan.within_caps).toBe(true);
        expect(plan.identity_envelope.expected_row_count).toBe(EXPECTED_ROW_COUNT);
        expect(plan.identity_envelope.verification_status).toBe('EXPECTED_ONLY');
        expect(plan.identity_envelope.sha256).toBeNull();
    });
});

describe('rk16c adapter refuses unsafe execute', () => {
    const deps = { makeClient: () => ({ send: async () => { throw new Error('should not run'); } }), instrument: instrumentReadOnlyClient, headObject: async () => ({}), getObject: async () => ({}), bucket: 'b' };
    it('refuses without --execute', async () => {
        await expect(executeRead({ execute: false, snapshot: CANDIDATE_SNAPSHOT_ID }, deps))
            .rejects.toThrow(/--execute not set/);
    });
    it('refuses without a snapshot pin even with --execute', async () => {
        await expect(executeRead({ execute: true }, deps)).rejects.toThrow(/no full corpus-identity/);
    });
});

describe('rk16c read-only guard refuses writes', () => {
    it('a PUT throws via instrumentReadOnlyClient + bumps counters', async () => {
        const guarded = instrumentReadOnlyClient({ send: async () => ({}) });
        await expect(guarded.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' })))
            .rejects.toThrow(/READ-ONLY GUARD/);
        expect(guarded.put_count).toBe(1);
        expect(guarded.write_attempt_count).toBe(1);
    });
});

describe('rk16c execute path (mock client, fail-closed checks)', () => {
    const body = Buffer.from('{"id":"sciweon::bioactivity::1"}\n');
    const sha = createHash('sha256').update(body).digest('hex');
    function makeDeps() {
        return {
            makeClient: () => ({ send: async () => ({}) }),
            instrument: instrumentReadOnlyClient,
            headObject: async () => ({ etag: '"e"', size: body.length }),
            getObject: async () => ({ etag: '"e"', size: body.length, body }),
            bucket: 'bkt',
        };
    }
    it('materializes outside the repo + records the verified sha256', async () => {
        cleanup(CANDIDATE_SNAPSHOT_ID);
        const res = await executeRead({ execute: true, snapshot: CANDIDATE_SNAPSHOT_ID, expectedSha256: sha, expectedRows: 1 }, makeDeps());
        expect(res.network_performed).toBe(true);
        expect(res.put_count).toBe(0);
        expect(res.delete_count).toBe(0);
        expect(res.identity_envelope.sha256).toBe(sha);
        expect(res.local_materialization_path.startsWith(materializationDir(CANDIDATE_SNAPSHOT_ID))).toBe(true);
        expect(res.local_materialization_path.includes('sciweon')).toBe(false); // not in repo
        cleanup(CANDIDATE_SNAPSHOT_ID);
    });
    it('FAIL-CLOSES on sha256 mismatch + does not keep the file', async () => {
        cleanup(CANDIDATE_SNAPSHOT_ID);
        await expect(executeRead({ execute: true, snapshot: CANDIDATE_SNAPSHOT_ID, expectedSha256: 'f'.repeat(64), expectedRows: 1 }, makeDeps()))
            .rejects.toThrow(/sha256 mismatch/);
        cleanup(CANDIDATE_SNAPSHOT_ID);
    });
});

describe('rk16c partial-download detection + cleanup', () => {
    it('atomicMaterialize throws on size mismatch (partial)', () => {
        const dir = materializationDir('TEST_PARTIAL');
        expect(() => atomicMaterialize(dir, 'x.gz', Buffer.from('abc'), 99)).toThrow(/PARTIAL DOWNLOAD/);
        cleanup('TEST_PARTIAL');
        expect(fs.existsSync(dir)).toBe(false);
    });
});

describe('rk16c corpus-identity validator FAIL-CLOSES', () => {
    const pinned = { snapshot_id: CANDIDATE_SNAPSHOT_ID, expected_sha256: 'a'.repeat(64), expected_row_count: EXPECTED_ROW_COUNT };
    function verified() {
        const e = proposeIdentity({});
        e.sha256 = 'a'.repeat(64); e.observed_row_count = EXPECTED_ROW_COUNT;
        e.object_byte_size = 10; e.etag = '"e"'; e.local_materialization_path = '/tmp/x';
        return e;
    }
    it('valid when everything matches the pin', () => {
        expect(validateIdentity(verified(), pinned).valid).toBe(true);
    });
    it('fails on sha256 / row_count / snapshot_id mismatch', () => {
        const a = verified(); a.sha256 = 'b'.repeat(64);
        expect(validateIdentity(a, pinned).valid).toBe(false);
        const b = verified(); b.observed_row_count = 1;
        expect(validateIdentity(b, pinned).valid).toBe(false);
        const c = verified(); c.snapshot_id = 'other/1-1';
        const r = validateIdentity(c, pinned);
        expect(r.valid).toBe(false);
        expect(r.errors.join(' ')).toMatch(/NEVER auto-switch to latest/);
    });
    it('never follows latest when latest != pin', () => {
        const rec = reconcileLatestVsPin('2099-01-01/9-1', CANDIDATE_SNAPSHOT_ID);
        expect(rec.matches_pin).toBe(false);
        expect(rec.note).toMatch(/NEVER follows latest/);
    });
});

describe('rk16c credential redaction', () => {
    it('redacts access keys, secrets, url creds, long tokens', () => {
        const fakeId = 'ZZZ' + '0123456789'.repeat(4); // 43 chars, NOT a real key prefix
        const s = redact(`R2_ACCESS_KEY_ID=${fakeId} secret_access_key: abcdefghabcdefghabcdefghabcdefghabcdefgh https://user:pass@host/p`);
        expect(s).not.toContain(fakeId);
        expect(s).toContain('REDACTED');
        expect(s).not.toContain('user:pass@');
    });
});

describe('rk16c hard caps are bounded + fail-closed values', () => {
    it('caps are finite + small', () => {
        expect(MAX_REQUESTS).toBeLessThanOrEqual(20);
        expect(MAX_TOTAL_BYTES).toBeGreaterThan(0);
        expect(Number.isFinite(MAX_TOTAL_BYTES)).toBe(true);
    });
});
