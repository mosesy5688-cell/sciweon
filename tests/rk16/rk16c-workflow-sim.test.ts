// @ts-nocheck
/**
 * RK-16C MANIFEST-ONLY PREFLIGHT WORKFLOW — FAKE-CLIENT SIMULATION (check 16).
 *
 * Proves the EXACT hardcoded command in the workflow YAML, when its argv is
 * parsed the same way the runner parses it, maps via selectAction to
 * 'preflight-execute' and -- driven through the runner's testable surface
 * (preflightManifest + extractPayloadPins) with FAKE deps -- does manifest-only
 * HEAD/GET, touching NO payload key and NO List command, and yields the payload
 * pins for an UNRATIFIED candidate.
 *
 * It deliberately exercises preflightManifest/extractPayloadPins directly rather
 * than runPreflight, so NO file is written to the shared results/ candidate path
 * (which rk16c-fullcorpus-runner.test.ts also uses; vitest runs files in
 * parallel). FAKE client + fake deps ONLY. ZERO network. NEVER makeR2Client.
 * NEVER production R2.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import {
    selectAction, extractPayloadPins,
} from '../../scripts/spikes/rk16c/lib/preflight-control.mjs';
import {
    preflightManifest,
} from '../../scripts/spikes/rk16c/lib/r2-readonly-adapter.mjs';
import { instrumentExactReadOnlyClient } from '../../scripts/spikes/rk16c/lib/exact-readonly-guard.mjs';
import {
    CANDIDATE_SNAPSHOT_ID, manifestObjectKey, bioactivitiesObjectKey,
} from '../../scripts/spikes/rk16c/lib/corpus-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.resolve(HERE, '../../.github/workflows/rk16c-manifest-preflight.yml');
const RAW = fs.readFileSync(WF_PATH, 'utf-8');

const MANIFEST = manifestObjectKey(CANDIDATE_SNAPSHOT_ID);
const PAYLOAD = bioactivitiesObjectKey(CANDIDATE_SNAPSHOT_ID);
const PAYLOAD_NAME = PAYLOAD.split('/').pop();

// Mirror the runner's parseArgs for the flags the hardcoded command uses.
function parseArgs(argv: string[]) {
    const a: any = { dryRun: true, execute: false, preflight: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--execute') { a.execute = true; a.dryRun = false; }
        else if (t === '--preflight') a.preflight = true;
        else if (t === '--snapshot') a.snapshot = argv[++i];
        else if (t === '--manifest-key') a.manifestKey = argv[++i];
    }
    return a;
}

// Extract the exact `node scripts/spikes/rk16c/run-fullcorpus.mjs ...` argv from
// the workflow YAML so the test is bound to what the workflow actually runs.
function workflowCommandArgv(): string[] {
    const line = RAW.split('\n').find((l) => l.includes('run-fullcorpus.mjs'));
    expect(line).toBeTruthy();
    const cmd = (line as string).trim().replace(/^run:\s*/, '');
    return cmd.split(/\s+/).slice(2); // drop "node" + script path
}

function manifestBody() {
    const files = [
        { filename: '_other.jsonl.gz', records: 3, compressed_bytes: 9, sha256_compressed: 'c'.repeat(64) },
        { filename: PAYLOAD_NAME, records: 475112, compressed_bytes: 62914560, sha256_compressed: 'b'.repeat(64) },
    ];
    return Buffer.from(JSON.stringify({ snapshot_id: CANDIDATE_SNAPSHOT_ID, files }));
}

// FAKE deps: a fake client records every Key it sees; head/getObject route REAL
// S3 command objects THROUGH the exact guard so the allowlist is enforced.
function fakeDeps(body: Buffer) {
    const seen: any[] = [];
    let makeClientCalls = 0;
    const fakeClient = {
        async send(command: any) {
            const ctor = command?.constructor?.name;
            seen.push({ ctor, key: command?.input?.Key ?? null });
            if (ctor === 'HeadObjectCommand') return { ETag: '"m"', ContentLength: body.length };
            return { ETag: '"m"', Body: body };
        },
    };
    const headObject = async (client: any, bucket: string, key: string) => {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { etag: r.ETag, size: r.ContentLength };
    };
    const getObject = async (client: any, bucket: string, key: string) => {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { etag: r.ETag, size: r.Body.length, body: r.Body };
    };
    return {
        seen,
        get makeClientCalls() { return makeClientCalls; },
        deps: {
            makeClient: () => { makeClientCalls += 1; return fakeClient; },
            instrument: instrumentExactReadOnlyClient,
            headObject, getObject, bucket: 'fake-bucket',
        },
    };
}

describe('check 16 — workflow command maps to preflight-execute -> manifest-only', () => {
    it('the workflow argv parses + selectAction()s to preflight-execute', () => {
        const args = parseArgs(workflowCommandArgv());
        expect(args.preflight).toBe(true);
        expect(args.execute).toBe(true);
        expect(args.snapshot).toBe(CANDIDATE_SNAPSHOT_ID);
        expect(args.manifestKey).toBe(MANIFEST);
        expect(selectAction(args).action).toBe('preflight-execute');
    });

    it('preflightManifest (fake deps) reads manifest HEAD+GET ONLY, no payload, no List; pins extracted', async () => {
        const args = parseArgs(workflowCommandArgv());
        const ctx = fakeDeps(manifestBody());

        const pf = await preflightManifest(
            { execute: true, snapshot: args.snapshot, manifestKey: args.manifestKey },
            ctx.deps,
        );

        // Exactly HEAD + GET of the manifest key. Nothing else.
        expect(ctx.seen).toEqual([
            { ctor: 'HeadObjectCommand', key: MANIFEST },
            { ctor: 'GetObjectCommand', key: MANIFEST },
        ]);
        // Payload key NEVER touched; no List command ever issued; one client only.
        expect(ctx.seen.some((s) => s.key === PAYLOAD)).toBe(false);
        expect(ctx.seen.some((s) => /^List/.test(s.ctor))).toBe(false);
        expect(ctx.makeClientCalls).toBe(1);
        expect(pf.manifest_key).toBe(MANIFEST);
        expect(pf.list_attempt_count).toBe(0);
        expect(pf.non_allowlisted_key_attempt_count).toBe(0);

        // Payload pins are read FROM the manifest body (no payload GET).
        const pins = extractPayloadPins(pf.manifest_body, PAYLOAD);
        expect(pins.compressed_bytes).toBe(62914560);
        expect(pins.sha256_compressed).toBe('b'.repeat(64));
        expect(pins.records).toBe(475112);
    });

    it('dry-run/fake-run network access = 0 (no real client; exactly 2 fake manifest reads)', async () => {
        const args = parseArgs(workflowCommandArgv());
        const ctx = fakeDeps(manifestBody());
        await preflightManifest(
            { execute: true, snapshot: args.snapshot, manifestKey: args.manifestKey },
            ctx.deps,
        );
        // 2 reads total (HEAD + GET), both the manifest -> zero payload bytes fetched.
        expect(ctx.seen.length).toBe(2);
        expect(ctx.seen.every((s) => s.key === MANIFEST)).toBe(true);
    });
});
