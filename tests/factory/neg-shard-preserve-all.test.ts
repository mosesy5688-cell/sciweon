// @ts-nocheck
/**
 * REQUIRED CI GATE — PRESERVE-ALL sum == wc-l.
 *
 * The partition is a PERMUTATION: every record in the validated
 * neg-evidence.jsonl routes to exactly one bucket via negKeyOf (orphans
 * included — they route by their id-derived orphan key, never dropped). This
 * test publishes a known jsonl (compound-subject, trial-subject, paper-orphan,
 * bioactivity-subject, and a no-subject orphan) through the real publisher and
 * asserts Sum(manifest.entries[].total over ALL buckets) === wc-l of the file.
 *
 * This is the gate that backs stage-4's runtime Sum==wc-l hard-fail.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { publishNegShards, groupNegByBucket } from '../../scripts/factory/lib/neg-shard-publisher.js';

// In-memory mock of the S3 client: captures PutObject bodies by key.
function mockClient() {
    const store = new Map();
    return {
        store,
        send(cmd) {
            const input = cmd.input;
            store.set(input.Key, input.Body);
            return Promise.resolve({});
        },
    };
}

function rec(i, subject, evidence_type = 'trial_failure', severity = 'minor') {
    return JSON.stringify({
        id: `sciweon::neg::x::ID${i}`,
        evidence_type,
        subject,
        severity,
        failure: { reason_category: 'OTHER' },
    });
}

async function writeJsonl(lines) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neg-preserve-'));
    const file = path.join(dir, 'neg-evidence.jsonl');
    await fs.writeFile(file, lines.join('\n'));
    return { dir, file };
}

describe('PRESERVE-ALL: sum(manifest totals) === wc-l', () => {
    it('every record routes to a bucket; sum equals line count (incl orphans)', async () => {
        const lines = [];
        // 30 compound-subject (3 distinct compounds)
        for (let i = 0; i < 30; i++) {
            lines.push(rec(i, { compound_id: `sciweon::compound::CID:${100 + (i % 3)}` }, 'inactive_bioassay', i % 4 === 0 ? 'critical' : 'minor'));
        }
        // 20 trial-subject (no compound_id)
        for (let i = 30; i < 50; i++) {
            lines.push(rec(i, { trial_id: `sciweon::trial::NCT${1000 + i}` }, 'trial_failure', 'major'));
        }
        // 10 paper-orphan (only paper_id)
        for (let i = 50; i < 60; i++) {
            lines.push(rec(i, { paper_id: `sciweon::paper::W${i}` }, 'paper_retraction', 'critical'));
        }
        // 8 bioactivity-subject
        for (let i = 60; i < 68; i++) {
            lines.push(rec(i, { bioactivity_id: `sciweon::bioactivity::B${i}` }, 'inactive_bioassay', 'minor'));
        }
        // 5 true orphans (empty subject -> id-derived orphan key)
        for (let i = 68; i < 73; i++) {
            lines.push(rec(i, {}, 'drug_withdrawal', 'unknown'));
        }
        const wc = lines.length; // 73

        const { dir, file } = await writeJsonl(lines);
        const client = mockClient();
        const result = await publishNegShards({
            client, bucket: 'test-bucket', jsonlPath: file,
            snapshotDate: '2026-06-05', outputRoot: path.join(dir, 'snapshots'),
        });

        // Sum across ALL uploaded manifests (one per non-empty bucket).
        let sum = 0;
        let manifestCount = 0;
        for (const [key, body] of client.store) {
            if (key.endsWith('/manifest.json')) {
                const m = JSON.parse(body);
                sum += m.total_records;
                manifestCount++;
            }
        }
        expect(result.totalRecords).toBe(wc);
        expect(result.sumOfTotals).toBe(wc);
        expect(sum).toBe(wc); // the load-bearing gate: SUM == wc-l
        expect(manifestCount).toBe(result.bucketCount);

        await fs.rm(dir, { recursive: true });
    });

    it('manifest entries carry a sev_by_type cross-tab that sums to severity_rollup + type_rollup, and is rebuild-deterministic', async () => {
        const lines = [];
        // One compound with a mix of types + severities so sev_by_type is non-trivial.
        const k = 'sciweon::compound::CID:777';
        for (let i = 0; i < 6; i++) lines.push(rec(i, { compound_id: k }, 'trial_failure', i < 4 ? 'critical' : 'major'));
        for (let i = 6; i < 10; i++) lines.push(rec(i, { compound_id: k }, 'black_box_warning', i < 8 ? 'critical' : 'minor'));
        for (let i = 10; i < 13; i++) lines.push(rec(i, { compound_id: k }, 'drug_withdrawal', 'unknown'));

        async function publishGetManifest() {
            const { dir, file } = await writeJsonl(lines);
            const client = mockClient();
            await publishNegShards({
                client, bucket: 'b', jsonlPath: file, snapshotDate: '2026-06-05', outputRoot: path.join(dir, 'snapshots'),
            });
            let manifestBody = null;
            for (const [key, body] of client.store) if (key.endsWith('/manifest.json')) manifestBody = body;
            await fs.rm(dir, { recursive: true });
            return manifestBody;
        }

        const body1 = await publishGetManifest();
        const body2 = await publishGetManifest();
        // Determinism: the serialized manifest is byte-identical EXCEPT the
        // wall-clock `generated_at` field (which is not content). Normalizing it
        // out, the entries (incl. the new sev_by_type cross-tab + its stable key
        // order) and shard_hashes are byte-for-byte reproducible.
        const stripTs = (b) => b.replace(/"generated_at":"[^"]*"/, '"generated_at":"X"');
        expect(stripTs(body1)).toBe(stripTs(body2));

        const m = JSON.parse(body1);
        const entry = m.entries.find(e => e.key === k);
        expect(entry).toBeTruthy();
        // sev_by_type present + restricted to the types in type_rollup.
        expect(Object.keys(entry.sev_by_type).sort()).toEqual(Object.keys(entry.type_rollup).sort());
        // Per-type vector sums to that type's type_rollup count.
        for (const [t, vec] of Object.entries(entry.sev_by_type)) {
            const s = vec[0] + vec[1] + vec[2] + vec[3];
            expect(s).toBe(entry.type_rollup[t]);
        }
        // Element-wise sum of all per-type vectors == the unfiltered severity_rollup.
        const summed = [0, 0, 0, 0];
        for (const vec of Object.values(entry.sev_by_type)) for (let j = 0; j < 4; j++) summed[j] += vec[j];
        expect(summed).toEqual(entry.severity_rollup);
        // Spot-check the known fixture: trial_failure = 4 critical + 2 major.
        expect(entry.sev_by_type.trial_failure).toEqual([4, 2, 0, 0]);
        expect(entry.sev_by_type.black_box_warning).toEqual([2, 0, 2, 0]);
        expect(entry.sev_by_type.drug_withdrawal).toEqual([0, 0, 0, 3]);
    });

    it('orphans (no subject key) are stored + counted, never dropped', async () => {
        const lines = [];
        for (let i = 0; i < 7; i++) lines.push(rec(i, {}, 'drug_withdrawal', 'unknown'));
        const { dir, file } = await writeJsonl(lines);
        const { byBucket, total, skippedMalformed } = await groupNegByBucket(file);
        let grouped = 0;
        for (const keyMap of byBucket.values()) for (const arr of keyMap.values()) grouped += arr.length;
        expect(skippedMalformed).toBe(0);
        expect(total).toBe(7);
        expect(grouped).toBe(7); // all orphans grouped, none dropped
        await fs.rm(dir, { recursive: true });
    });

    it('malformed lines HARD-FAIL the publish (no silent drop)', async () => {
        const lines = ['{"id":"sciweon::neg::x::1","subject":{},"severity":"minor","evidence_type":"trial_failure"}', '{not json}'];
        const { dir, file } = await writeJsonl(lines);
        const client = mockClient();
        await expect(publishNegShards({
            client, bucket: 'b', jsonlPath: file, snapshotDate: '2026-06-05', outputRoot: path.join(dir, 'snapshots'),
        })).rejects.toThrow(/malformed/i);
        await fs.rm(dir, { recursive: true });
    });
});
