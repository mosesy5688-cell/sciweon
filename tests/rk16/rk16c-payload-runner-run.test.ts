// @ts-nocheck
/**
 * RK-16C D-129 PAYLOAD RUNNER - reconciliation + streaming decode + guard + CLI
 * wiring tests. FAKE clients only, ZERO network. Covers 18-suite cases 7,8,9,10,11,
 * 12,14,17,18 plus the happy path (read order + envelope) and selectAction/runFullRun
 * wiring. Materialization is isolated to a test-only tag so it never collides.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { executeFullRunGated, fullRunAllowlist } from '../../scripts/spikes/rk16c/lib/fullcorpus-run-gate.mjs';
import { selectAction, runFullRun } from '../../scripts/spikes/rk16c/lib/preflight-control.mjs';
import { computeDryRunPlan, cleanup } from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    fixtureLock, writeLock, fakeDeps, goodPayloadBodies, FIXTURE_PINS, GZ,
    SEAL_KEY, FILE_KEY, PAYLOAD_KEY, PREFIX,
} from './rk16c-payload-runner-fixtures';

const TAG = 'D129-RUNTEST';
const runOpts = (over: any = {}) => ({ authorizedForPayloadRead: true, pins: FIXTURE_PINS, materializeTag: TAG, ...over });
afterAll(() => cleanup(TAG));

describe('D-129 happy path - reconcile-before-payload + streaming decode envelope', () => {
    it('reads seal, then sibling, THEN payload; verifies pins; reports the envelope', async () => {
        const w = writeLock(fixtureLock());
        const { seen, deps } = fakeDeps(goodPayloadBodies());
        const report = await executeFullRunGated(runOpts({ lockPath: w.path, expectedLockSha256: w.sha }), deps);
        expect(seen).toEqual([
            { ctor: 'HeadObjectCommand', key: SEAL_KEY }, { ctor: 'GetObjectCommand', key: SEAL_KEY },
            { ctor: 'HeadObjectCommand', key: FILE_KEY }, { ctor: 'GetObjectCommand', key: FILE_KEY },
            { ctor: 'HeadObjectCommand', key: PAYLOAD_KEY }, { ctor: 'GetObjectCommand', key: PAYLOAD_KEY },
        ]);
        expect(report.rows_decoded).toBe(GZ.rows);
        expect(report.payload_uncompressed_bytes).toBe(GZ.uncompressed_bytes);
        expect(report.payload_sha256_uncompressed).toBe(GZ.uncomp_sha);
        expect(report.decompressed_file_written).toBe(false);
        expect(report.reconciliation).toEqual({ root_manifest_sha256_ok: true, file_manifest_sha256_ok: true, keys_ok: true, snapshot_identity_ok: true });
        expect(report.put_count).toBe(0); expect(report.list_count).toBe(0);
        expect(report.peak_memory.rss).toBeGreaterThan(0);
        cleanup(TAG);
    });

    it('test 18 - emits parameter-candidate/envelope output ONLY (no family/reader/F4/latest/api/registration)', async () => {
        const w = writeLock(fixtureLock());
        const report = await executeFullRunGated(runOpts({ lockPath: w.path, expectedLockSha256: w.sha }), fakeDeps(goodPayloadBodies()).deps);
        expect(report.output_kind).toMatch(/parameter-candidate|envelope|row-count-hash|supplemental/);
        expect(report.emitted_family_artifact).toBe(false);
        expect(report.emitted_reader_package).toBe(false);
        expect(report.emitted_f4_candidate).toBe(false);
        expect(report.emitted_latest_update).toBe(false);
        expect(report.emitted_public_api_route).toBe(false);
        expect(report.emitted_family_registration).toBe(false);
        expect(JSON.stringify(report)).not.toContain('latest.json');
        cleanup(TAG);
    });
});

describe('D-129 payload is never read before reconciliation / on decode mismatch', () => {
    it('test 14 - a root/sibling reconcile mismatch throws BEFORE the payload GET', async () => {
        const w = writeLock(fixtureLock({ root_manifest_sha256: 'a'.repeat(64) }));
        const { seen, deps } = fakeDeps(goodPayloadBodies());
        await expect(executeFullRunGated(runOpts({ lockPath: w.path, expectedLockSha256: w.sha }), deps))
            .rejects.toThrow(/root seal sha256 != lock pin.*BEFORE PAYLOAD GET/);
        expect(seen.some((s: any) => s.key === PAYLOAD_KEY)).toBe(false);
    });
    it('test 7 - wrong uncompressed hash -> fail DURING decode', async () => {
        const w = writeLock(fixtureLock({ payload_sha256_uncompressed: 'a'.repeat(64) }));
        const pins = { ...FIXTURE_PINS, payload_sha256_uncompressed: 'a'.repeat(64) };
        await expect(executeFullRunGated(runOpts({ lockPath: w.path, expectedLockSha256: w.sha, pins }), fakeDeps(goodPayloadBodies()).deps))
            .rejects.toThrow(/uncompressed sha256 != lock pin.*during decode/);
        cleanup(TAG);
    });
    it('test 8 - wrong row count -> fail (during decode)', async () => {
        const w = writeLock(fixtureLock({ expected_row_count: GZ.rows + 1 }));
        const pins = { ...FIXTURE_PINS, expected_row_count: GZ.rows + 1 };
        await expect(executeFullRunGated(runOpts({ lockPath: w.path, expectedLockSha256: w.sha, pins }), fakeDeps(goodPayloadBodies()).deps))
            .rejects.toThrow(/row count != lock pin.*during decode/);
        cleanup(TAG);
    });
});

describe('D-129 exact-readonly guard over the full-run allowlist (cases 9-12)', () => {
    const allow = fullRunAllowlist(fixtureLock()); // [seal, sibling, payload]
    const g = () => instrumentExactReadOnlyClient({ send: async () => ({}) }, allow);
    it('the run allowlist is EXACTLY seal + sibling + payload; payload allowlisted ONLY here', async () => {
        expect(allow).toEqual([SEAL_KEY, FILE_KEY, PAYLOAD_KEY]);
        await expect(instrumentExactReadOnlyClient({ send: async () => ({}) }, [SEAL_KEY, FILE_KEY]).send(new GetObjectCommand({ Bucket: 'b', Key: PAYLOAD_KEY }))).rejects.toThrow(/non-allowlisted key/);
    });
    it('test 9 - latest.json rejected', async () => { await expect(g().send(new GetObjectCommand({ Bucket: 'b', Key: 'snapshots/latest.json' }))).rejects.toThrow(/non-allowlisted key/); });
    it('test 10 - R2 List rejected', async () => { await expect(g().send(new ListObjectsV2Command({ Bucket: 'b', Prefix: 'snapshots/' }))).rejects.toThrow(/LIST\/discovery/); });
    it('test 11 - R2 Write/Delete rejected', async () => {
        await expect(g().send(new PutObjectCommand({ Bucket: 'b', Key: PAYLOAD_KEY, Body: 'x' }))).rejects.toThrow(/no Put/);
        await expect(g().send(new DeleteObjectCommand({ Bucket: 'b', Key: PAYLOAD_KEY }))).rejects.toThrow(/no Delete/);
    });
    it('test 12 - non-allowlisted key rejected', async () => { await expect(g().send(new GetObjectCommand({ Bucket: 'b', Key: PREFIX + 'other.jsonl.gz' }))).rejects.toThrow(/non-allowlisted key/); });
});

describe('D-129 CLI routing + dry-run zero-network + runFullRun dispatch', () => {
    it('selectAction: --full-run --lock -> full-run; --full-run alone -> fail-closed; generic --execute stays refused', () => {
        expect(selectAction({ fullRun: true, lockPath: '/x/lock.json' }).action).toBe('full-run');
        expect(selectAction({ fullRun: true }).action).toBe('fail-closed');
        expect(selectAction({ execute: true, preflight: false, lockPath: '/x' }).action).toBe('execute-refused');
        expect(selectAction({ execute: true, preflight: false }).action).toBe('execute-refused');
    });
    it('test 17 - dry-run performs zero network', () => {
        expect(selectAction({}).action).toBe('dry-run-matrix');
        expect(computeDryRunPlan({}).network_performed).toBe(false);
    });
    it('runFullRun dispatches to the gate and fails-before-network on a non-ratified lock (no client touched)', async () => {
        const w = writeLock(fixtureLock()); // real file, but not the ratified artifact
        const { seen, deps } = fakeDeps(goodPayloadBodies());
        await expect(runFullRun({ lockPath: w.path, authorizedForPayloadRead: true }, deps))
            .rejects.toThrow(/lock file sha256 != ratified pin.*FAIL BEFORE NETWORK/);
        expect(seen.length).toBe(0);
    });
});
