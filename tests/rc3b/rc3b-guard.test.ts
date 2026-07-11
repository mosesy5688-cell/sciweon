// @ts-nocheck
/**
 * RC-3B-P0B command guard: default-deny by command CLASS + exact bucket/key
 * allowlist + no-network-after-STOP. Every case asserts the EXACT number of
 * commands that reached the recording client (0 for a fail-before-network
 * rejection) and the guard's own counters -- not just that an error was thrown.
 */
import { describe, it, expect } from 'vitest';
import { PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Budget } from '../../scripts/rc3b-audit/budget.mjs';
import { buildGuard, buildClient, basePlan, stdResponder } from './rc3b-fixtures';

class GetBucketAclCommand { constructor(input) { this.input = input; } }

describe('RC-3B-P0B guard: mutation + unknown rejected BEFORE network', () => {
    it('a PutObject / DeleteObject is refused before reaching the client (0 network calls)', async () => {
        const { guard, calls } = buildGuard({ exactKeys: ['k'] });
        await expect(guard.send(new PutObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'k', Body: 'x' }))).rejects.toThrow(/MUTATION/);
        await expect(guard.send(new DeleteObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'k' }))).rejects.toThrow(/MUTATION/);
        expect(calls.length).toBe(0);
        expect(guard.mutation_attempt_count).toBe(2);
        expect(guard.write_attempt_count).toBe(2);
        expect(guard.network_calls_after_stop).toBe(0);
    });

    it('an unknown/unexpected command is refused before network (0 calls)', async () => {
        const { guard, calls } = buildGuard({ exactKeys: ['k'] });
        await expect(guard.send(new GetBucketAclCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'k' }))).rejects.toThrow(/UNKNOWN command/);
        expect(calls.length).toBe(0);
        expect(guard.unexpected_command_count).toBe(1);
    });
});

describe('RC-3B-P0B guard: bucket + key allowlist (default-deny)', () => {
    it('a non-allowlisted bucket is refused before network', async () => {
        const { guard, calls } = buildGuard({ exactKeys: ['k'] });
        await expect(guard.send(new HeadObjectCommand({ Bucket: 'some-other-bucket', Key: 'k' }))).rejects.toThrow(/non-allowlisted bucket/);
        expect(calls.length).toBe(0);
        expect(guard.out_of_bucket_count).toBe(1);
    });

    it('a non-allowlisted key / prefix is refused before network', async () => {
        const { guard, calls } = buildGuard({ exactKeys: ['allowed'], exactPrefixes: ['ok/'] });
        await expect(guard.send(new GetObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'not-allowed' }))).rejects.toThrow(/non-allowlisted key/);
        await expect(guard.send(new ListObjectsV2Command({ Bucket: 'rc3b-synthetic-bucket', Prefix: 'evil/' }))).rejects.toThrow(/non-allowlisted prefix/);
        expect(calls.length).toBe(0);
        expect(guard.non_allowlisted_count).toBe(2);
    });

    it('an allowlisted read DOES reach the client exactly once', async () => {
        const { guard, calls } = buildGuard({ exactKeys: ['allowed'], responder: () => ({ ETag: '"e"', ContentLength: 1 }) });
        await guard.send(new HeadObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'allowed' }));
        expect(calls.length).toBe(1);
        expect(guard.head_count).toBe(1);
    });
});

describe('RC-3B-P0B guard: no network call after STOP', () => {
    it('once the budget is STOPPED, an allowlisted read is refused: an ATTEMPT, not a network call', async () => {
        const budget = new Budget({});
        budget.stop('CAP_REACHED');
        const { guard, calls } = buildGuard({ exactKeys: ['allowed'], budget });
        await expect(guard.send(new GetObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'allowed' }))).rejects.toThrow(/STOPPED/);
        expect(calls.length).toBe(0);
        // The refusal is counted as an ATTEMPT; no actual network call occurred.
        expect(guard.attempts_after_stop).toBe(1);
        expect(guard.network_calls_after_stop).toBe(0);
    });
});

describe('RC-3B-P0B guard: a boundary-ignoring client would leak (guard is load-bearing)', () => {
    it('WITHOUT the guard a rogue client records the mutation; WITH the guard it is blocked', async () => {
        // Rogue path: a naive client that ignores the boundary DOES receive the Put.
        const rogueCalls: any[] = [];
        const rogue = { async send(c) { rogueCalls.push(c.constructor.name); return {}; } };
        await rogue.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' }));
        expect(rogueCalls).toEqual(['PutObjectCommand']); // proves a boundary-ignoring client leaks

        // Guarded path: the SAME mutation never reaches the network.
        const { guard, calls } = buildGuard({ exactKeys: ['k'] });
        await expect(guard.send(new PutObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'k', Body: 'x' }))).rejects.toThrow(/MUTATION/);
        expect(calls.length).toBe(0);            // guard blocked it: test FAILS if the boundary is ignored
        expect(guard.write_attempt_count).toBe(1);
    });
});

describe('RC-3B-P0B: object-cap pre-network reservation + post-STOP counter semantics', () => {
    it('reserveObject throws BEFORE network when the next unique object exceeds the cap', async () => {
        const plan = basePlan({ class_c_head_keys: ['p/a.gz', 'p/b.gz'] });
        const { rc, calls, budget } = buildClient(plan, { caps: { MAX_OBJECTS_TOUCHED_PER_RUN: 1 }, responder: stdResponder() });
        await rc.headExactKey('p/a.gz');
        expect(calls.length).toBe(1);
        await expect(rc.headExactKey('p/b.gz')).rejects.toThrow(/object cap reached|CAP_REACHED|STOPPED/);
        expect(calls.length).toBe(1); // 'p/b.gz' never reached the network
        expect(budget.stopped).toBe(true);
        expect(budget.objectsTouched).toBe(1);
    });

    it('after a STOP, an attempted send bumps attempts_after_stop and leaves network_calls_after_stop === 0', async () => {
        const budget = new Budget({});
        budget.stop('CAP_REACHED');
        const { guard } = buildGuard({ exactKeys: ['allowed'], budget });
        await expect(guard.send(new HeadObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'allowed' }))).rejects.toThrow(/STOPPED/);
        await expect(guard.send(new GetObjectCommand({ Bucket: 'rc3b-synthetic-bucket', Key: 'allowed' }))).rejects.toThrow(/STOPPED/);
        expect(guard.attempts_after_stop).toBe(2);
        expect(guard.network_calls_after_stop).toBe(0);
    });
});
