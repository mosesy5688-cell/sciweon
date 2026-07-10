// @ts-nocheck
/**
 * RK-16C D-129 PAYLOAD RUNNER - FAIL-BEFORE-NETWORK gate tests. FAKE deps only,
 * ZERO network; every case here throws BEFORE a client can be constructed (or, for
 * the memory-breach/disk cases, before any HEAD/GET). Also proves the exact ratified
 * constants are bound and the explicit payload-read grant is REQUIRED (the artifact's
 * own authorized_for_payload_read field is never trusted).
 */
import { describe, it, expect } from 'vitest';
import {
    executeFullRunGated, RATIFIED_LOCK_FILE_SHA256, RATIFIED_PINS, PAYLOAD_READ_AUTHZ_ENV,
} from '../../scripts/spikes/rk16c/lib/fullcorpus-run-gate.mjs';
import {
    ratifiedLock, fixtureLock, writeLock, throwingDeps, FIXTURE_PINS, PREFIX,
} from './rk16c-payload-runner-fixtures';

const GRANT = { authorizedForPayloadRead: true };
async function expectFailBeforeNetwork(opts: any, re: RegExp) {
    const { deps, wasClientMade } = throwingDeps();
    await expect(executeFullRunGated(opts, deps)).rejects.toThrow(re);
    expect(wasClientMade()).toBe(false);
}

describe('D-129 exact ratified constants are bound (drift guard)', () => {
    it('lock-file + payload pins equal the spec values', () => {
        expect(RATIFIED_LOCK_FILE_SHA256).toBe('e6383dfe6df0895b827ab85c6d970418c86d87f9e5749d7bc850a4e313c909bd');
        expect(RATIFIED_PINS.candidate_lock_schema).toBe('rk16c-fullcorpus-lock-v2');
        expect(RATIFIED_PINS.snapshot_id).toBe('2026-06-14/27502029137-1');
        expect(RATIFIED_PINS.payload_key).toBe('snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz');
        expect(RATIFIED_PINS.payload_sha256_compressed).toBe('4fe46a756b0492a3cd24fb3e7034f63a352b907fa9dd9ddd203d77fead7f203f');
        expect(RATIFIED_PINS.payload_sha256_uncompressed).toBe('652d1b2884ec13e8c89b52f830596d6be6cca9e70e9085634d6442907f655d38');
        expect(RATIFIED_PINS.expected_row_count).toBe(475112);
        expect(RATIFIED_PINS.trust_anchor_mode).toBe('producer-contract-derived-sibling-v1');
        expect(RATIFIED_PINS.payload_membership_authority).toBe('required_satellite_ssot');
        expect(RATIFIED_PINS.payload_pin_authority).toBe('sibling_manifest_files');
    });
});

describe('D-129 fail-before-network gate (18-suite cases 1-6, 13)', () => {
    it('test 1 - missing lock -> fail before network', async () => {
        await expectFailBeforeNetwork({ ...GRANT, lockPath: undefined }, /no --lock path supplied.*FAIL BEFORE NETWORK/);
    });
    it('test 2 - wrong lock file hash -> fail before network', async () => {
        const w = writeLock(fixtureLock()); // real file, but its sha != the ratified pin
        await expectFailBeforeNetwork({ ...GRANT, lockPath: w.path }, /lock file sha256 != ratified pin.*FAIL BEFORE NETWORK/);
    });
    it('test 3 - wrong schema -> fail before network', async () => {
        const w = writeLock(ratifiedLock({ candidate_lock_schema: 'rk16c-fullcorpus-lock-vX' }));
        await expectFailBeforeNetwork({ ...GRANT, lockPath: w.path, expectedLockSha256: w.sha }, /candidate_lock_schema|structurally invalid|FAIL BEFORE NETWORK/);
    });
    it('test 4 - wrong snapshot id -> fail before network', async () => {
        const w = writeLock(ratifiedLock({ snapshot_id: '2099-01-01/9-9' }));
        await expectFailBeforeNetwork({ ...GRANT, lockPath: w.path, expectedLockSha256: w.sha }, /snapshot_id != ratified pin.*FAIL BEFORE NETWORK/);
    });
    it('test 5 - wrong payload key -> fail before network', async () => {
        const w = writeLock(ratifiedLock({ payload_key: PREFIX + 'not-the-payload.jsonl.gz' }));
        await expectFailBeforeNetwork({ ...GRANT, lockPath: w.path, expectedLockSha256: w.sha }, /payload_key != ratified pin.*FAIL BEFORE NETWORK/);
    });
    it('test 6 - wrong compressed hash -> fail before network', async () => {
        const w = writeLock(ratifiedLock({ payload_sha256_compressed: 'f'.repeat(64) }));
        await expectFailBeforeNetwork({ ...GRANT, lockPath: w.path, expectedLockSha256: w.sha }, /payload_sha256_compressed != ratified pin.*FAIL BEFORE NETWORK/);
    });
    it('test 13 - payload cannot be read before lock validation (no client constructed)', async () => {
        const w = writeLock(ratifiedLock({ payload_sha256_uncompressed: 'f'.repeat(64) }));
        await expectFailBeforeNetwork({ ...GRANT, lockPath: w.path, expectedLockSha256: w.sha }, /payload_sha256_uncompressed != ratified pin.*FAIL BEFORE NETWORK/);
    });
});

describe('D-129 explicit payload-read grant is REQUIRED (artifact field never trusted)', () => {
    it('a fully-ratified lock WITHOUT the explicit grant fails before network', async () => {
        const w = writeLock(ratifiedLock());
        await expectFailBeforeNetwork({ lockPath: w.path, expectedLockSha256: w.sha }, /no explicit payload-read authorization grant.*FAIL BEFORE NETWORK/);
    });
    it('a lock whose OWN authorized_for_payload_read=true STILL fails without the grant', async () => {
        const w = writeLock(ratifiedLock({ authorized_for_payload_read: true }));
        await expectFailBeforeNetwork({ lockPath: w.path, expectedLockSha256: w.sha }, /NOT trusted|no explicit payload-read authorization grant/);
    });
    it('the env-name the future D-134 gate sets is bound', () => {
        expect(PAYLOAD_READ_AUTHZ_ENV).toBe('RK16C_D134_PAYLOAD_READ_AUTHORIZED');
    });
});

describe('D-129 resource envelope aborts before network (cases 15, 16)', () => {
    it('test 16 - disk-preflight failure aborts before network', async () => {
        const w = writeLock(fixtureLock({ payload_compressed_bytes: 1e18 }));
        await expectFailBeforeNetwork(
            { ...GRANT, lockPath: w.path, expectedLockSha256: w.sha, pins: FIXTURE_PINS },
            /disk preflight FAILED BEFORE NETWORK/,
        );
    });
    it('test 15 - memory-envelope breach terminates the run before network', async () => {
        const w = writeLock(fixtureLock());
        await expectFailBeforeNetwork(
            { ...GRANT, lockPath: w.path, expectedLockSha256: w.sha, pins: FIXTURE_PINS, memory: { maxHeapUsedBytes: 1, intervalMs: 5 } },
            /memory ceiling breached.*TERMINATED/,
        );
    });
});
