// @ts-nocheck
/**
 * PR-INV-ISOLATE 2026-05-28: Phase Isolation Blueprint for stage-3 invariant.
 *
 * Stage 3 owns its own state lifecycle via `state/f3-aggregated-stats.json`.
 * NO read of SC's `state/source-completeness.json` (which decoupled from raw
 * UNII count post Option E and produced false-regression on F3 run 26531937648).
 *
 * Contract:
 *   - Auto-bootstrap: missing stats file -> write current as baseline + return
 *     checked=false reason=bootstrap_initialized (NO throw).
 *   - Green: current >= prev -> write advanced baseline + return checked=true.
 *   - Regression: current < prev -> THROW + DO NOT overwrite baseline.
 *   - SC state file is NEVER consulted (cross-stage isolation lock).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Module-level captures so the hoisted vi.mock factory can close over them.
const sentCommands: any[] = [];
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
    return {
        S3Client: class { send = mockSend; },
        GetObjectCommand: class { constructor(args: any) { Object.assign(this, args, { __type: 'Get' }); } },
        PutObjectCommand: class { constructor(args: any) { Object.assign(this, args, { __type: 'Put' }); } },
    };
});

import { enforceCompletenessInvariant } from '../../scripts/factory/lib/aggregated-invariant.js';

const ENV_SETUP = {
    R2_ENDPOINT: 'https://r2.fake',
    R2_BUCKET: 'sciweon-fake',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
};

async function writeTempCompounds(unicount: number, totalCount: number): Promise<string> {
    const p = path.join(os.tmpdir(), `inv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const records: string[] = [];
    for (let i = 0; i < unicount; i++) records.push(JSON.stringify({ external_ids: { unii: `U${i}` } }));
    for (let i = 0; i < totalCount - unicount; i++) records.push(JSON.stringify({ external_ids: { unii: null } }));
    await fs.writeFile(p, records.join('\n'), 'utf-8');
    return p;
}

function streamFromString(s: string) {
    return {
        async *[Symbol.asyncIterator]() { yield Buffer.from(s, 'utf-8'); },
    };
}

// Helper: builds a mockSend implementation that always pushes the command
// to sentCommands first, then runs the per-test handler list in order.
function setupSendQueue(handlers: Array<((cmd: any) => any) | undefined>) {
    let i = 0;
    mockSend.mockReset();
    mockSend.mockImplementation(async (cmd: any) => {
        sentCommands.push(cmd);
        const h = handlers[i++];
        if (h) return await h(cmd);
        return {};
    });
}

describe('PR-INV-ISOLATE: enforceCompletenessInvariant with isolated stats file', () => {
    beforeEach(() => {
        for (const [k, v] of Object.entries(ENV_SETUP)) process.env[k] = v;
        sentCommands.length = 0;
        mockSend.mockReset();
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('1. auto-bootstrap: missing stats file writes current as baseline + returns reason=bootstrap_initialized', async () => {
        setupSendQueue([
            () => { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; },
        ]);
        const localFile = await writeTempCompounds(100, 120);

        const r = await enforceCompletenessInvariant({ localCompoundsPath: localFile, runId: 'run-A' });

        expect(r.checked).toBe(false);
        expect(r.reason).toBe('bootstrap_initialized');
        expect(r.current).toBe(100);

        // First call was the Get; second call was the Put-baseline.
        expect(sentCommands).toHaveLength(2);
        expect(sentCommands[0].__type).toBe('Get');
        expect(sentCommands[0].Key).toBe('state/f3-aggregated-stats.json');
        expect(sentCommands[1].__type).toBe('Put');
        expect(sentCommands[1].Key).toBe('state/f3-aggregated-stats.json');
        const written = JSON.parse(sentCommands[1].Body);
        expect(written.universal_unii_count).toBe(100);
        expect(written.last_processed_run_id).toBe('run-A');
        expect(written.bootstrap).toBe(true);

        await fs.unlink(localFile);
    });

    it('2. green path: current >= prev writes advanced baseline + returns checked=true', async () => {
        const prevBody = JSON.stringify({ universal_unii_count: 100, total_compounds: 120, last_processed_run_id: 'run-A' });
        setupSendQueue([
            () => ({ Body: streamFromString(prevBody) }),
        ]);
        const localFile = await writeTempCompounds(125, 150);

        const r = await enforceCompletenessInvariant({ localCompoundsPath: localFile, runId: 'run-B' });

        expect(r.checked).toBe(true);
        expect(r.prev).toBe(100);
        expect(r.current).toBe(125);
        expect(r.delta).toBe(25);

        expect(sentCommands).toHaveLength(2);
        const written = JSON.parse(sentCommands[1].Body);
        expect(written.universal_unii_count).toBe(125);
        expect(written.last_processed_run_id).toBe('run-B');
        expect(written.prior_run_id).toBe('run-A');
        expect(written.prior_universal_unii_count).toBe(100);
        expect(written.prior_delta).toBe(25);

        await fs.unlink(localFile);
    });

    it('3. regression: current < prev THROWS without writing baseline', async () => {
        const prevBody = JSON.stringify({ universal_unii_count: 200, total_compounds: 250, last_processed_run_id: 'run-A' });
        setupSendQueue([
            () => ({ Body: streamFromString(prevBody) }),
        ]);
        const localFile = await writeTempCompounds(150, 200);  // 150 < 200 = regression

        await expect(
            enforceCompletenessInvariant({ localCompoundsPath: localFile, runId: 'run-B' })
        ).rejects.toThrow(/CRITICAL REGRESSION DETECTED.*200 -> 150.*delta=-50/);

        // Only 1 Get call -- baseline NOT written on hard-fail path.
        expect(sentCommands).toHaveLength(1);
        expect(sentCommands[0].__type).toBe('Get');

        await fs.unlink(localFile);
    });

    it('4. ANTI-REGRESSION: no SC state file consulted (cross-stage isolation lock)', async () => {
        // If invariant accidentally regresses to reading SC state, the test
        // mock would receive a Get with key state/source-completeness.json.
        // Architect Phase Isolation Blueprint forbids this.
        setupSendQueue([
            () => { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; },
        ]);
        const localFile = await writeTempCompounds(50, 60);

        await enforceCompletenessInvariant({ localCompoundsPath: localFile, runId: 'run-X' });

        for (const cmd of sentCommands) {
            expect(cmd.Key).not.toBe('state/source-completeness.json');
            expect(cmd.Key).toBe('state/f3-aggregated-stats.json');
        }

        await fs.unlink(localFile);
    });

    it('5. equal-count edge: current === prev passes as green (advance with delta=0)', async () => {
        const prevBody = JSON.stringify({ universal_unii_count: 100, total_compounds: 120, last_processed_run_id: 'run-A' });
        setupSendQueue([
            () => ({ Body: streamFromString(prevBody) }),
        ]);
        const localFile = await writeTempCompounds(100, 130);

        const r = await enforceCompletenessInvariant({ localCompoundsPath: localFile, runId: 'run-B' });

        expect(r.checked).toBe(true);
        expect(r.delta).toBe(0);
        expect(sentCommands).toHaveLength(2);

        await fs.unlink(localFile);
    });

    it('6. malformed prev stats blob (missing universal_unii_count) triggers bootstrap path', async () => {
        // Defensive: if state file exists but lacks expected field (corrupted /
        // partial write from prior aborted cycle), bootstrap rather than throw.
        const malformedBody = JSON.stringify({ random: 'garbage', audit_date: '2026-01-01' });
        setupSendQueue([
            () => ({ Body: streamFromString(malformedBody) }),
        ]);
        const localFile = await writeTempCompounds(75, 80);

        const r = await enforceCompletenessInvariant({ localCompoundsPath: localFile, runId: 'run-C' });
        expect(r.checked).toBe(false);
        expect(r.reason).toBe('bootstrap_initialized');

        await fs.unlink(localFile);
    });
});
