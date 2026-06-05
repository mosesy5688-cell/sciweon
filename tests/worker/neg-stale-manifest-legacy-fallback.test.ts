// @ts-nocheck
/**
 * FIX M4 (worker side) — stale/missing manifest object -> legacy, NOT 503;
 * genuine shard-read throw (manifest EXISTS) -> still LOUD 503.
 *
 * The inverted dual-path must keep its OOM protection: a sharded read that
 * THROWS (manifest present, a shard read fails) is still a NegShardError (503),
 * never a silent legacy fallback that could re-introduce the OOM / a false-clean.
 * The ONLY new behavior: a manifest key present in latest.json whose per-bucket
 * manifest OBJECT is missing (a stale pointer at a shard-less date) is treated as
 * key-ABSENT -> legacy whole-file path (HEAD.size-guarded), not a 503-all-day.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { publishNegShards } from '../../scripts/factory/lib/neg-shard-publisher.js';
import { loadNegEvidenceForCompound, NegShardError } from '../../src/worker/lib/neg-evidence-loader';

const COMPOUND = 'sciweon::compound::CID:2244';
const DATE = '2026-06-05';
const BASE = 'https://sciweon.com';

// neg-manifest-loader uses caches.default; Node has none -> no-op always-miss shim.
beforeAll(() => {
    if (typeof (globalThis as any).caches === 'undefined') {
        (globalThis as any).caches = { default: { async match() { return undefined; }, async put() { } } };
    }
});

function buildLines(n = 10) {
    const lines = [];
    for (let i = 0; i < n; i++) {
        lines.push(JSON.stringify({
            id: `sciweon::neg::trial_failure::T${String(10000 + i).padStart(6, '0')}`,
            evidence_type: 'trial_failure', subject: { compound_id: COMPOUND },
            severity: 'major', failure: { reason_category: 'SAFETY' },
        }));
    }
    return lines;
}

// In-memory store doubling as the publisher's S3 client (PutObject) and the
// worker's R2Bucket (head / get / get-range). Mirrors the filtered-serving test.
function makeStore() {
    const map = new Map();
    let seq = 0;
    const put = (key, body) => {
        const bytes = typeof body === 'string'
            ? new TextEncoder().encode(body)
            : new Uint8Array(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength ?? body.length);
        map.set(key, { bytes, etag: `etag-${++seq}` });
    };
    const client = { send(cmd) { put(cmd.input.Key, cmd.input.Body); return Promise.resolve({}); } };
    const slab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const bucket = {
        async head(key) { const o = map.get(key); return o ? { size: o.bytes.byteLength, etag: o.etag } : null; },
        async get(key, opts) {
            const o = map.get(key);
            if (!o) return null;
            if (opts?.range) {
                const s = o.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length);
                return { etag: o.etag, async arrayBuffer() { return slab(s); } };
            }
            return { etag: o.etag, async arrayBuffer() { return slab(o.bytes); } };
        },
    };
    return { map, client, bucket, put };
}

function gzip(text) { return zlib.gzipSync(Buffer.from(text, 'utf-8')); }

async function publishToStore(lines, store) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neg-m4-'));
    const file = path.join(dir, 'neg-evidence.jsonl');
    await fs.writeFile(file, lines.join('\n'));
    await publishNegShards({ client: store.client, bucket: 'b', jsonlPath: file, snapshotDate: DATE, outputRoot: path.join(dir, 'snapshots') });
    return dir;
}

describe('neg loader FIX M4 — missing manifest object -> legacy, shard throw -> 503', () => {
    it('stale key present but per-bucket manifest object MISSING -> legacy whole-file (no 503)', async () => {
        const lines = buildLines();
        const store = makeStore();
        // Pointer ADVERTISES a sharded snapshot (stale key) ...
        store.put('snapshots/latest.json', JSON.stringify({ latest_snapshot_date: DATE, neg_evidence_manifest_key: `snapshots/${DATE}/neg-evidence/` }));
        // ... but NO per-bucket manifest / shards were published for DATE.
        // A legacy whole-file IS present (the producer always writes it).
        store.put(`snapshots/${DATE}/neg-evidence.jsonl.gz`, gzip(lines.join('\n')));

        const r = await loadNegEvidenceForCompound(store.bucket, COMPOUND, BASE, null, { offset: 0, limit: 200 });
        // Served from the LEGACY path (all 10 records), NOT a 503.
        expect(r.negative_signals_count).toBe(10);
        expect(r.signals.length).toBe(10);
    });

    it('manifest EXISTS but a shard read THROWS -> still LOUD 503 (NegShardError), no fallback', async () => {
        const lines = buildLines();
        const store = makeStore();
        const dir = await publishToStore(lines, store);
        store.put('snapshots/latest.json', JSON.stringify({ latest_snapshot_date: DATE, neg_evidence_manifest_key: `snapshots/${DATE}/neg-evidence/` }));
        // Corrupt the OOM protection's contract: delete the shard .bin object so the
        // range-read fails AFTER the manifest (which exists) is loaded.
        for (const key of [...store.map.keys()]) {
            if (key.includes('/neg-evidence/') && key.endsWith('.bin')) store.map.delete(key);
        }
        await expect(
            loadNegEvidenceForCompound(store.bucket, COMPOUND, BASE, null, { offset: 0, limit: 200 }),
        ).rejects.toBeInstanceOf(NegShardError);
        await fs.rm(dir, { recursive: true });
    });

    it('manifest EXISTS + shards intact -> normal sharded serve (no regression)', async () => {
        const lines = buildLines();
        const store = makeStore();
        const dir = await publishToStore(lines, store);
        store.put('snapshots/latest.json', JSON.stringify({ latest_snapshot_date: DATE, neg_evidence_manifest_key: `snapshots/${DATE}/neg-evidence/` }));
        const r = await loadNegEvidenceForCompound(store.bucket, COMPOUND, BASE, null, { offset: 0, limit: 200 });
        expect(r.negative_signals_count).toBe(10);
        await fs.rm(dir, { recursive: true });
    });
});
