// @ts-nocheck
/**
 * RK-16C TWO-MANIFEST PREFLIGHT WORKFLOW — FAKE-CLIENT SIMULATION (D-106 §17.22-25).
 *
 * Proves the EXACT command in rk16c-two-manifest-preflight.yml, parsed the way the
 * runner parses it, maps via selectAction to 'preflight-execute' and -- driven
 * through preflightManifest with FAKE deps -- reads ONLY the two exact metadata
 * objects (root seal + deterministic sibling manifest.json), REJECTS a third key
 * and any payload HEAD/GET, and performs ZERO production network access. FAKE
 * client ONLY. NEVER makeR2Client. NEVER production R2.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { canonicalManifestHash } from '../../scripts/factory/lib/snapshot-identity.js';
import { selectAction } from '../../scripts/spikes/rk16c/lib/preflight-control.mjs';
import { preflightManifest } from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    CANDIDATE_SNAPSHOT_ID, manifestObjectKey, fileManifestObjectKey,
    bioactivitiesObjectKey, objectPrefixOf,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.resolve(HERE, '../../.github/workflows/rk16c-two-manifest-preflight.yml');
const RAW = fs.readFileSync(WF_PATH, 'utf-8');

const SNAP = CANDIDATE_SNAPSHOT_ID;
const PREFIX = objectPrefixOf(SNAP);
const SEAL = manifestObjectKey(SNAP);
const FILE_KEY = fileManifestObjectKey(SNAP);
const PAYLOAD = bioactivitiesObjectKey(SNAP);
const BIO = 'bioactivities.jsonl.gz';

function parseArgs(argv: string[]) {
    const a: any = { execute: false, preflight: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--execute') a.execute = true;
        else if (t === '--preflight') a.preflight = true;
        else if (t === '--snapshot') a.snapshot = argv[++i];
        else if (t === '--manifest-key') a.manifestKey = argv[++i];
    }
    return a;
}
function workflowCommandArgv(): string[] {
    const line = RAW.split('\n').find((l) => l.includes('run-fullcorpus.mjs'));
    expect(line).toBeTruthy();
    return (line as string).trim().replace(/^run:\s*/, '').split(/\s+/).slice(2);
}
function sealBody() {
    const sats = [PREFIX + BIO, PREFIX + 'papers.jsonl.gz'];
    const core = {
        layout_version: 'immutable_snapshot_v2', schema_version: 1, snapshot_id: SNAP, snapshot_date: '2026-06-14',
        object_prefix: PREFIX, run_id: '27502029137', run_attempt: '1', compound_total_records: 1, compound_shard_hashes: ['x'],
        required_inventory: [...sats], satellite_inventory: sats,
    };
    return Buffer.from(JSON.stringify({ ...core, manifest_hash: canonicalManifestHash(core) }));
}
function fileBody() {
    return Buffer.from(JSON.stringify({
        snapshot_id: SNAP, object_prefix: PREFIX, schema_version: 1, run_id: '27502029137',
        files: [
            { filename: BIO, records: 475112, compressed_bytes: 62914560, sha256_compressed: 'b'.repeat(64) },
            { filename: 'papers.jsonl.gz', records: 36153, compressed_bytes: 48000000, sha256_compressed: 'c'.repeat(64) },
        ],
    }));
}
function fakeDeps(bodies: Record<string, Buffer>) {
    const seen: any[] = [];
    let makeClientCalls = 0;
    const client = {
        async send(command: any) {
            const ctor = command?.constructor?.name; const key = command?.input?.Key ?? null;
            seen.push({ ctor, key });
            const b = bodies[key];
            if (b === undefined) throw new Error(`fake: no body for ${key}`);
            if (ctor === 'HeadObjectCommand') return { ETag: '"m"', ContentLength: b.length };
            return { ETag: '"m"', Body: b };
        },
    };
    const headObject = async (c: any, bk: string, k: string) => { const r = await c.send(new HeadObjectCommand({ Bucket: bk, Key: k })); return { etag: r.ETag, size: r.ContentLength }; };
    const getObject = async (c: any, bk: string, k: string) => { const r = await c.send(new GetObjectCommand({ Bucket: bk, Key: k })); return { etag: r.ETag, size: r.Body.length, body: r.Body }; };
    return { seen, get makeClientCalls() { return makeClientCalls; }, deps: { makeClient: () => { makeClientCalls += 1; return client; }, instrument: instrumentExactReadOnlyClient, headObject, getObject, bucket: 'fake-bucket' } };
}

describe('D-106 §17.22-25 — workflow command -> two-manifest metadata-only (fake)', () => {
    it('workflow argv parses + selectAction -> preflight-execute', () => {
        const args = parseArgs(workflowCommandArgv());
        expect(args.preflight && args.execute).toBe(true);
        expect(args.snapshot).toBe(SNAP);
        expect(args.manifestKey).toBe(SEAL);
        expect(selectAction(args).action).toBe('preflight-execute');
    });

    it('22 — reads EXACTLY the two metadata objects (seal then sibling); one client', async () => {
        const args = parseArgs(workflowCommandArgv());
        const ctx = fakeDeps({ [SEAL]: sealBody(), [FILE_KEY]: fileBody() });
        const pf = await preflightManifest({ execute: true, snapshot: args.snapshot, manifestKey: args.manifestKey }, ctx.deps);
        expect(ctx.seen).toEqual([
            { ctor: 'HeadObjectCommand', key: SEAL },
            { ctor: 'GetObjectCommand', key: SEAL },
            { ctor: 'HeadObjectCommand', key: FILE_KEY },
            { ctor: 'GetObjectCommand', key: FILE_KEY },
        ]);
        expect(ctx.makeClientCalls).toBe(1);
        expect(pf.candidate.payload_sha256_compressed).toBe('b'.repeat(64));
    });

    it('23 — a THIRD object key is rejected by the exact guard', () => {
        const g = instrumentExactReadOnlyClient({ send: async () => ({ ETag: '"e"', ContentLength: 1, Body: 'x' }) }, [SEAL, FILE_KEY]);
        return expect(g.send(new GetObjectCommand({ Bucket: 'b', Key: PREFIX + 'compounds-search.jsonl.gz' })))
            .rejects.toThrow(/non-allowlisted key/);
    });

    it('24 — payload HEAD/GET is rejected (payload never allowlisted)', async () => {
        const g = instrumentExactReadOnlyClient({ send: async () => ({ ETag: '"e"', ContentLength: 1, Body: 'x' }) }, [SEAL, FILE_KEY]);
        await expect(g.send(new HeadObjectCommand({ Bucket: 'b', Key: PAYLOAD }))).rejects.toThrow(/non-allowlisted key/);
        await expect(g.send(new GetObjectCommand({ Bucket: 'b', Key: PAYLOAD }))).rejects.toThrow(/non-allowlisted key/);
    });

    it('25 — fake run = exactly 4 metadata reads; zero payload/List; zero production network', async () => {
        const args = parseArgs(workflowCommandArgv());
        const ctx = fakeDeps({ [SEAL]: sealBody(), [FILE_KEY]: fileBody() });
        const pf = await preflightManifest({ execute: true, snapshot: args.snapshot, manifestKey: args.manifestKey }, ctx.deps);
        expect(ctx.seen.length).toBe(4);
        expect(ctx.seen.every((s) => s.key === SEAL || s.key === FILE_KEY)).toBe(true);
        expect(ctx.seen.some((s) => s.key === PAYLOAD)).toBe(false);
        expect(ctx.seen.some((s) => /^List/.test(s.ctor))).toBe(false);
        expect(pf.list_attempt_count).toBe(0);
        expect(pf.non_allowlisted_key_attempt_count).toBe(0);
    });
});
