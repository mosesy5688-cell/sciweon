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
