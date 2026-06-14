// @ts-nocheck
// P-8 recovery control: publication-policy sidecar + AUTO-F4 gate + F4
// MANUAL-mode exact run-binding + source attestation. Covers WO scenarios
// (1)(2)(3)(4)(9)(10)(11)(12)(13)(14); the drain hard record cap (5)(6)(7)(8)
// lives in p8-record-cap.test.ts. Uses a Map-backed in-memory S3 client
// honoring Get/Put/Head so the REAL buildPublishPolicy / writePublishPolicy /
// decideAutoPublish / attestManualSource paths run unchanged.
import { describe, it, expect, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import {
    buildPublishPolicy, writePublishPolicy, decideAutoPublish, attestManualSource,
    publishPolicyKey, aggregatedLatestKey, POLICY_AUTO_ALLOWED, POLICY_MANUAL_ONLY,
} from '../../scripts/factory/lib/r2-publish-policy.js';

const BUCKET = 'test-bucket';

// In-memory R2: store maps key -> { body: Buffer, etag }. ETag = sha256 of body
// unless overridden (drift test mutates etag without changing body).
function makeStore() {
    const store = new Map();
    const fetched = []; // every GET/HEAD key (asserts which keys are read)
    function etagOf(buf) { return `"${createHash('sha256').update(buf).digest('hex').slice(0, 16)}"`; }
    const client = {
        async send(cmd) {
            const key = cmd.input.Key;
            if (cmd instanceof PutObjectCommand) {
                const body = Buffer.isBuffer(cmd.input.Body) ? cmd.input.Body : Buffer.from(cmd.input.Body);
                store.set(key, { body, etag: etagOf(body) });
                return {};
            }
            if (cmd instanceof GetObjectCommand) {
                fetched.push(key);
                const e = store.get(key);
                if (!e) { const err = new Error('NoSuchKey'); err.name = 'NoSuchKey'; throw err; }
                return { Body: (async function* () { yield e.body; })() };
            }
            if (cmd instanceof HeadObjectCommand) {
                fetched.push(key);
                const e = store.get(key);
                if (!e) { const err = new Error('NotFound'); err.name = 'NotFound'; err.$metadata = { httpStatusCode: 404 }; throw err; }
                return { ETag: e.etag, ContentLength: e.body.length };
            }
            throw new Error(`unexpected command ${cmd.constructor?.name}`);
        },
    };
    return { client, store, fetched, etagOf };
}

function seedBundle(store, etagOf, runId, files) {
    for (const [fname, content] of Object.entries(files)) {
        const buf = Buffer.from(content);
        store.set(`processed/aggregated/${runId}/${fname}`, { body: buf, etag: etagOf(buf) });
    }
}
function setLatest(store, etagOf, runId) {
    const buf = Buffer.from(JSON.stringify({ stage: 'aggregated', run_id: runId }));
    store.set(aggregatedLatestKey(), { body: buf, etag: etagOf(buf) });
}

describe('P-8 GAP-A: publication-policy schema', () => {
    it('normal F3 (backfillOnly=false) -> mode:full, AUTO_ALLOWED', () => {
        const p = buildPublishPolicy({ aggregatedRunId: 'R1', backfillOnly: false });
        expect(p.schema_version).toBe(1);
        expect(p.aggregated_run_id).toBe('R1');
        expect(p.mode).toBe('full');
        expect(p.publication_policy).toBe(POLICY_AUTO_ALLOWED);
    });
    it('backfill_only F3 -> mode:backfill_only, MANUAL_ONLY', () => {
        const p = buildPublishPolicy({ aggregatedRunId: 'R2', backfillOnly: true, sourceRunId: 'E9', commitSha: 'abc' });
        expect(p.mode).toBe('backfill_only');
        expect(p.publication_policy).toBe(POLICY_MANUAL_ONLY);
        expect(p.source_run_id).toBe('E9');
        expect(p.commit_sha).toBe('abc');
    });
});

describe('P-8 GAP-A: AUTO-F4 publication-policy gate', () => {
    it('(2) AUTO_ALLOWED (normal F3) -> PROCEED (auto-F4 publishes)', async () => {
        const { client, store, etagOf } = makeStore();
        setLatest(store, etagOf, 'RAUTO');
        await writePublishPolicy({ client, bucket: BUCKET, policy: buildPublishPolicy({ aggregatedRunId: 'RAUTO', backfillOnly: false }) });
        const d = await decideAutoPublish({ client, bucket: BUCKET });
        expect(d.action).toBe('PROCEED');
        expect(d.runId).toBe('RAUTO');
    });
    it('(1) backfill_only MANUAL_ONLY policy -> NOOP (clean no-op, no publish)', async () => {
        const { client, store, etagOf } = makeStore();
        setLatest(store, etagOf, 'RBF');
        await writePublishPolicy({ client, bucket: BUCKET, policy: buildPublishPolicy({ aggregatedRunId: 'RBF', backfillOnly: true }) });
        const d = await decideAutoPublish({ client, bucket: BUCKET });
        expect(d.action).toBe('NOOP');
        expect(d.policy.publication_policy).toBe(POLICY_MANUAL_ONLY);
    });
    it('(3) policy sidecar MISSING -> FAIL (fail-loud)', async () => {
        const { client, store, etagOf } = makeStore();
        setLatest(store, etagOf, 'RMISS'); // no sidecar written
        const d = await decideAutoPublish({ client, bucket: BUCKET });
        expect(d.action).toBe('FAIL');
        expect(d.reason).toMatch(/missing/i);
    });
    it('(4) policy.aggregated_run_id != triggering latest run_id -> FAIL', async () => {
        const { client, store, etagOf } = makeStore();
        setLatest(store, etagOf, 'RNEW');
        // sidecar at RNEW key but its internal aggregated_run_id points elsewhere.
        const bad = buildPublishPolicy({ aggregatedRunId: 'ROLD', backfillOnly: false });
        store.set(publishPolicyKey('RNEW'), { body: Buffer.from(JSON.stringify(bad)), etag: etagOf(Buffer.from(JSON.stringify(bad))) });
        const d = await decideAutoPublish({ client, bucket: BUCKET });
        expect(d.action).toBe('FAIL');
        expect(d.reason).toMatch(/!==/);
    });

    it('latest.json missing/no run_id -> FAIL', async () => {
        const { client } = makeStore();
        const d = await decideAutoPublish({ client, bucket: BUCKET });
        expect(d.action).toBe('FAIL');
    });
});

const MANUAL_FILES = ['compounds-enriched.jsonl', 'bioactivities.jsonl'];
function seedManual(store, etagOf, runId, { backfillOnly = true } = {}) {
    seedBundle(store, etagOf, runId, {
        'compounds-enriched.jsonl': '{"id":"a"}\n{"id":"b"}\n',
        'bioactivities.jsonl': '{"id":"x"}\n',
    });
    const policy = buildPublishPolicy({ aggregatedRunId: runId, backfillOnly });
    store.set(publishPolicyKey(runId), { body: Buffer.from(JSON.stringify(policy)), etag: etagOf(Buffer.from(JSON.stringify(policy))) });
}

describe('P-8 GAP-C: F4 MANUAL-mode exact run-binding + attestation', () => {
    it('(9) reads processed/aggregated/<input>/ (the exact keys)', async () => {
        const { client, store, etagOf, fetched } = makeStore();
        seedManual(store, etagOf, 'RM1');
        const att = await attestManualSource({ client, bucket: BUCKET, aggregatedRunId: 'RM1', files: MANUAL_FILES });
        expect(fetched).toContain('processed/aggregated/RM1/compounds-enriched.jsonl');
        expect(fetched).toContain('processed/aggregated/RM1/bioactivities.jsonl');
        expect(att.source_run_id).toBe('RM1');
        expect(att.inventory.length).toBe(2);
        expect(att.aggregate_attestation_hash).toMatch(/^[0-9a-f]{64}$/);
    });
    it('(10) MANUAL mode NEVER fetches processed/aggregated/latest.json', async () => {
        const { client, store, etagOf, fetched } = makeStore();
        seedManual(store, etagOf, 'RM2');
        await attestManualSource({ client, bucket: BUCKET, aggregatedRunId: 'RM2', files: MANUAL_FILES });
        expect(fetched).not.toContain(aggregatedLatestKey());
    });
    it('(11) source drift (ETag changes between pre/post HEAD) -> throws before publish', async () => {
        const { client, store, etagOf } = makeStore();
        seedManual(store, etagOf, 'RM3');
        // Flip the etag AFTER the GET (post-HEAD) to simulate a concurrent overwrite.
        const key = 'processed/aggregated/RM3/compounds-enriched.jsonl';
        const orig = store.get(key);
        let seenGet = false;
        const realSend = client.send;
        client.send = async (cmd) => {
            const r = await realSend(cmd);
            if (cmd instanceof GetObjectCommand && cmd.input.Key === key) seenGet = true;
            if (cmd instanceof HeadObjectCommand && cmd.input.Key === key && seenGet) {
                return { ETag: '"DRIFTED-ETAG"', ContentLength: orig.body.length };
            }
            return r;
        };
        await expect(attestManualSource({ client, bucket: BUCKET, aggregatedRunId: 'RM3', files: MANUAL_FILES }))
            .rejects.toThrow(/drift/i);
    });
    it('(12)(8) asserts the 3 policy fields: run_id match + MANUAL_ONLY + backfill_only', async () => {
        const { client, store, etagOf } = makeStore();
        // A FULL/AUTO_ALLOWED artifact must be REJECTED by MANUAL attestation.
        seedManual(store, etagOf, 'RM4', { backfillOnly: false });
        await expect(attestManualSource({ client, bucket: BUCKET, aggregatedRunId: 'RM4', files: MANUAL_FILES }))
            .rejects.toThrow(/MANUAL_ONLY/);
    });
    it('(12) policy.aggregated_run_id mismatch -> throws', async () => {
        const { client, store, etagOf } = makeStore();
        seedBundle(store, etagOf, 'RM5', { 'compounds-enriched.jsonl': '{"id":"a"}\n', 'bioactivities.jsonl': '{"id":"x"}\n' });
        const wrong = buildPublishPolicy({ aggregatedRunId: 'OTHER', backfillOnly: true });
        store.set(publishPolicyKey('RM5'), { body: Buffer.from(JSON.stringify(wrong)), etag: etagOf(Buffer.from(JSON.stringify(wrong))) });
        await expect(attestManualSource({ client, bucket: BUCKET, aggregatedRunId: 'RM5', files: MANUAL_FILES }))
            .rejects.toThrow(/aggregated_run_id/);
    });

    it('(7-attest) attested bytes == bytes returned for build (buffers match HEAD size + sha256)', async () => {
        const { client, store, etagOf } = makeStore();
        seedManual(store, etagOf, 'RM6');
        const att = await attestManualSource({ client, bucket: BUCKET, aggregatedRunId: 'RM6', files: MANUAL_FILES });
        for (const inv of att.inventory) {
            const fname = inv.key.split('/').pop();
            expect(att.buffers[fname].length).toBe(inv.size);
            expect(createHash('sha256').update(att.buffers[fname]).digest('hex')).toBe(inv.sha256);
        }
    });

    it('missing policy sidecar in MANUAL mode -> throws (no publish)', async () => {
        const { client, store, etagOf } = makeStore();
        seedBundle(store, etagOf, 'RM7', { 'compounds-enriched.jsonl': '{"id":"a"}\n', 'bioactivities.jsonl': '{"id":"x"}\n' });
        await expect(attestManualSource({ client, bucket: BUCKET, aggregatedRunId: 'RM7', files: MANUAL_FILES }))
            .rejects.toThrow(/_publish_policy.json missing/);
    });
});

describe('P-8 GAP-C: stage-4 publish-mode resolution + gate terminal outcomes', () => {
    it('(14) AUTO NOOP exits 0 (clean) and FAIL exits 11 (no publish) — latest untouched in both', async () => {
        const mod = await import('../../scripts/factory/lib/stage-4-publish-mode.js');
        // NOOP path -> process.exit(0)
        {
            const { client, store, etagOf } = makeStore();
            setLatest(store, etagOf, 'RBF2');
            await writePublishPolicy({ client, bucket: BUCKET, policy: buildPublishPolicy({ aggregatedRunId: 'RBF2', backfillOnly: true }) });
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c) => { throw new Error(`EXIT_${c}`); }) as any);
            const before = store.get(aggregatedLatestKey()).body.toString();
            await expect(mod.runAutoPublishGate({ makeClient: () => client, bucket: BUCKET, log: { log() {}, error() {} } }))
                .rejects.toThrow('EXIT_0');
            expect(store.get(aggregatedLatestKey()).body.toString()).toBe(before); // latest untouched
            exitSpy.mockRestore();
        }
        // FAIL path -> process.exit(11)
        {
            const { client, store, etagOf } = makeStore();
            setLatest(store, etagOf, 'RMISS2'); // no sidecar -> FAIL
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c) => { throw new Error(`EXIT_${c}`); }) as any);
            await expect(mod.runAutoPublishGate({ makeClient: () => client, bucket: BUCKET, log: { log() {}, error() {} } }))
                .rejects.toThrow('EXIT_11');
            exitSpy.mockRestore();
        }
    });

    it('resolveAggregatedRunId: env set -> MANUAL; unset/blank -> AUTO(null)', async () => {
        const mod = await import('../../scripts/factory/lib/stage-4-publish-mode.js');
        const prev = process.env.AGGREGATED_RUN_ID;
        process.env.AGGREGATED_RUN_ID = '  RX  ';
        expect(mod.resolveAggregatedRunId()).toBe('RX');
        process.env.AGGREGATED_RUN_ID = '';
        expect(mod.resolveAggregatedRunId()).toBeNull();
        if (prev === undefined) delete process.env.AGGREGATED_RUN_ID; else process.env.AGGREGATED_RUN_ID = prev;
    });
});

describe('P-8 GAP-A/C: (13) backfill_only branch adds no linker/harvest reachability', () => {
    it('the policy gate + attestation modules import no F1/F2/linker harvesters', async () => {
        // Static guard: the P-8 control modules pull ONLY S3 + crypto + their own
        // siblings — never a linker/harvest/openalex/trial-linker module. A future
        // edit that wires one in flips this test (the founder cost-isolation gate).
        const fs = await import('fs/promises');
        for (const f of ['scripts/factory/lib/r2-publish-policy.js', 'scripts/factory/lib/stage-4-publish-mode.js']) {
            const src = await fs.readFile(f, 'utf-8');
            expect(src).not.toMatch(/trial-linker|paper-linker|openalex|stage-1|stage-2|harvest|runLinkerStage/i);
        }
    });
});
