// @ts-nocheck
/**
 * PR-COMPOUND-GUARD (Step-5a) F6 — compound-shard-publisher oversize tripwire.
 *
 * Today packShards is fail-OPEN: a single record > MAX_SHARD_BYTES is silently
 * written into an oversized shard the worker range-fetches whole (re-OOM). F6
 * makes it FAIL-SOFT-LOUD (NOT hard-fail -- that would halt the daily publish
 * for ALL ~130K compounds over one fat record): the oversize record goes into
 * its OWN shard + a LOUD oversize_shard telemetry count + the cid. A SEPARATE
 * hard ceiling (MAX_RECORD_BYTES) hard-fails only a record beyond the worker
 * single-record range-fetch budget.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { packShards } from '../../scripts/factory/lib/compound-shard-publisher.js';

// Small thresholds so the routing is exercised without a 10MB zstd compress
// (the bundled zstd WASM heap OOMs on a true MAX_SHARD_BYTES=10MB single record;
// production runs in a full Node runner. opts.maxShardBytes injects the bound).
const SHARD = 4096;       // 4KB test shard bound
const RECORD = 64 * 1024; // 64KB test hard ceiling
const OPTS = { maxShardBytes: SHARD, maxRecordBytes: RECORD };

function rec(cid: number, rawLen: number) {
    return {
        cid, inchi_key: null, chembl_id: null, unii: null, drugbank_id: null,
        raw: Buffer.alloc(rawLen, 0x41), // 'A' * rawLen
    };
}

async function tmpdir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'compound-shard-oversize-'));
}

describe('packShards F6 oversize tripwire (fail-soft-loud)', () => {
    it('isolates a > maxShardBytes single record into its own shard + LOUD telemetry', async () => {
        const dir = await tmpdir();
        const records = [
            rec(1, 100),
            rec(2, SHARD + 512),   // self-oversize -> own shard
            rec(3, 100),
        ];
        const { entries, oversizeShardCount, oversizeCids } = await packShards(records, dir, OPTS);

        expect(oversizeShardCount).toBe(1);
        expect(oversizeCids).toEqual([2]);

        // the fat record lands on a shard ALONE (no other entry shares it).
        const fatEntry = entries.find(e => e.cid === 2);
        const sharers = entries.filter(e => e.shard === fatEntry.shard);
        expect(sharers).toHaveLength(1);
        expect(sharers[0].cid).toBe(2);

        // the records before + after it are NOT on the oversize shard.
        expect(entries.find(e => e.cid === 1).shard).not.toBe(fatEntry.shard);
        expect(entries.find(e => e.cid === 3).shard).not.toBe(fatEntry.shard);

        await fs.rm(dir, { recursive: true, force: true });
    });

    it('does NOT hard-fail the publish over one fat record (preserve-all availability)', async () => {
        const dir = await tmpdir();
        const records = [rec(1, SHARD + 512)];
        // must RESOLVE, not reject.
        const res = await packShards(records, dir, OPTS);
        expect(res.entries.map(e => e.cid)).toEqual([1]); // record preserved
        expect(res.oversizeShardCount).toBe(1);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('a normal corpus produces zero oversize_shard telemetry', async () => {
        const dir = await tmpdir();
        const records = [rec(1, 256), rec(2, 256), rec(3, 256)];
        const res = await packShards(records, dir, OPTS);
        expect(res.oversizeShardCount).toBe(0);
        expect(res.oversizeCids).toEqual([]);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('HARD-FAILS a single record beyond maxRecordBytes (range-fetch budget)', async () => {
        const dir = await tmpdir();
        const records = [rec(7, RECORD + 1)];
        await expect(packShards(records, dir, OPTS)).rejects.toThrow(/MAX_RECORD_BYTES/);
        await fs.rm(dir, { recursive: true, force: true });
    });
});
