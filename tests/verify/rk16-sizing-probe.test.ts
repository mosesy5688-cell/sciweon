// @ts-nocheck
/**
 * RK-16 read-only sizing probe tests -- mock S3 client + tiny gzipped fixtures
 * (zlib.gzipSync). Locks: (1) per-family metrics on the fixtures; (2) the
 * read-only verdict (put/delete/write_attempt all 0); (3) a DRIFTED latest
 * (snapshot_id != expected) HARD FAILS; (4) the reused guard refuses a write.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { Readable } from 'stream';
import {
    PutObjectCommand, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { instrumentReadOnlyClient } from '../../scripts/verify/p8-r1-readonly-probe-lib.js';
import { SnapshotDriftError } from '../../scripts/verify/rk16-sizing-probe-lib.js';
import { runSizingProbe } from '../../scripts/verify/rk16-sizing-probe.js';
import {
    byteStats, unionEdgeCount, danglingEdgeCount, buildSizingEstimates,
} from '../../scripts/verify/rk16-sizing-metrics.js';

const BUCKET = 'sciweon-r2';
const SNAPSHOT_ID = '2026-06-14/27502029137-1';
const PREFIX = `snapshots/${SNAPSHOT_ID}/`;

function jsonl(rows) { return rows.map(r => JSON.stringify(r)).join('\n') + '\n'; }
function gz(rows) { return gzipSync(Buffer.from(jsonl(rows), 'utf-8')); }

function latestBody(over = {}) {
    return JSON.stringify({
        layout_version: 'immutable_snapshot_v2',
        snapshot_id: SNAPSHOT_ID,
        object_prefix: PREFIX,
        compounds_manifest_key: `${PREFIX}compounds/bucket-0000/manifest.json`,
        manifest_hash: 'mh',
        ...over,
    });
}

// Two papers: P1 mentions C1,C2 ; P2 mentions C1.
const PAPERS = [
    { id: 'P1', mentioned_compounds: [{ compound_id: 'C1' }, { compound_id: 'C2' }] },
    { id: 'P2', mentioned_compounds: [{ compound_id: 'C1' }] },
];
// paper-links: C1->P1 (dup of a mention), C3->P_GHOST (dangling: P_GHOST not in papers).
const PAPER_LINKS = [
    { compound_id: 'C1', paper_id: 'P1' },
    { compound_id: 'C3', paper_id: 'P_GHOST' },
];
// 3 bioactivities: C1 has 2 rows (T1 w/ uniprot, T2 no uniprot), C2 has 1 (T1).
const BIOS = [
    { compound_id: 'C1', target_id: 'T1', target: { uniprot_accession: 'P00533' }, is_active: true, activity_type: 'IC50' },
    { compound_id: 'C1', target_id: 'T2', target: {}, is_active: false, activity_type: 'Ki' },
    { compound_id: 'C2', target_id: 'T1', target: { uniprot_accession: 'P00533' }, is_active: true, activity_type: 'IC50' },
];
const TRIALS = [{ nct_id: 'NCT1' }, { nct_id: 'NCT2' }];
const TRIAL_LINKS = [{ compound_id: 'C1', nct_id: 'NCT1' }];

function makeStore(opts = {}) {
    const store = new Map();
    store.set(`${PREFIX}papers.jsonl.gz`, gz(PAPERS));
    store.set(`${PREFIX}paper-links.jsonl.gz`, gz(PAPER_LINKS));
    store.set(`${PREFIX}bioactivities.jsonl.gz`, gz(BIOS));
    store.set(`${PREFIX}trials.jsonl.gz`, gz(TRIALS));
    store.set(`${PREFIX}trial-links.jsonl.gz`, gz(TRIAL_LINKS));
    store.set(`${PREFIX}neg-evidence/bucket-0000/manifest.json`, Buffer.from('{}', 'utf-8'));
    store.set('snapshots/latest.json', Buffer.from(opts.latest ?? latestBody(), 'utf-8'));
    return store;
}

function makeMock(store) {
    return {
        store,
        async send(cmd) {
            const name = cmd.constructor.name;
            if (name === 'ListObjectsV2Command') {
                const prefix = cmd.input.Prefix;
                const keys = [...store.keys()].filter(k => k.startsWith(prefix));
                return { IsTruncated: false, Contents: keys.map(k => ({ Key: k, Size: store.get(k).length })) };
            }
            if (name === 'HeadObjectCommand') {
                const o = store.get(cmd.input.Key);
                if (!o) { const e = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                return { ContentLength: o.length };
            }
            if (name === 'GetObjectCommand') {
                const o = store.get(cmd.input.Key);
                if (!o) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                return { Body: Readable.from([o]) }; // Node Readable, like AWS SDK v3.
            }
            const e = new Error(`mock store reached by write command ${name} -- guard FAILED`);
            e.name = 'WriteReachedStore';
            throw e;
        },
    };
}

describe('RK16 pure metrics', () => {
    it('byteStats avg/p50/p95/max', () => {
        const s = byteStats([10, 20, 30, 40]);
        expect(s.max).toBe(40);
        expect(s.avg).toBe(25);
        expect(s.p50).toBe(20);
    });
    it('union dedupes mentions + links by compound::paper; dangling counts ghosts', () => {
        const u = unionEdgeCount(PAPER_LINKS, [
            { compound_id: 'C1', paper_id: 'P1' }, { compound_id: 'C2', paper_id: 'P1' }, { compound_id: 'C1', paper_id: 'P2' },
        ]);
        // edges: C1::P1 (both), C3::P_GHOST, C2::P1, C1::P2 -> 4 distinct.
        expect(u.union_edge_count).toBe(4);
        expect(u.paper_links_edge_count).toBe(2);
        expect(danglingEdgeCount(PAPER_LINKS, new Set(['P1', 'P2']))).toBe(1);
    });
    it('sizing estimates are derived + labeled', () => {
        const s = buildSizingEstimates({
            papers_union_edge_count: 4, bio_compound_edges: 3, bio_target_edges: 3,
            max_compound_degree: 2, max_target_degree: 2,
        });
        expect(s.posting_entry_count).toBe(10);
        expect(s.index_size_estimate).toBe(10 * 16);
        expect(s.page_count_under_candidate_page_sizes['64']).toBe(1);
        expect(s.estimated_worst_case_page_reads['64']).toBe(1);
        expect(s.assumptions.note).toMatch(/ESTIMATES/);
    });
});

describe('RK16 probe end-to-end on gz fixtures', () => {
    it('(1) computes per-family metrics + (2) read-only verdict clean', async () => {
        const client = instrumentReadOnlyClient(makeMock(makeStore()));
        const r = await runSizingProbe(client, BUCKET, SNAPSHOT_ID);

        // papers
        expect(r.papers.record_count).toBe(2);
        expect(r.papers.unique_paper_count).toBe(2);
        expect(r.papers.paper_links_edge_count).toBe(2);
        // mentions: C1::P1,C2::P1,C1::P2 (3) + links C1::P1(dup),C3::P_GHOST -> 4 union.
        expect(r.papers.union_edge_count).toBe(4);
        expect(r.papers.dangling_edge_count).toBe(1); // P_GHOST not in papers.
        expect(r.papers.compressed_bytes).toBeGreaterThan(0);

        // bioactivities
        expect(r.bioactivities.record_count).toBe(3);
        expect(r.bioactivities.compound_cardinality).toBe(2); // C1,C2
        expect(r.bioactivities.target_id_cardinality).toBe(2); // T1,T2
        expect(r.bioactivities.uniprot_coverage).toBeCloseTo(2 / 3);
        expect(r.bioactivities.chembl_target_id_coverage).toBe(1);
        expect(r.bioactivities.is_active_distribution.true).toBe(2);
        expect(r.bioactivities.is_active_distribution.false).toBe(1);
        expect(r.bioactivities.activity_type_distribution.IC50).toBe(2);

        // repurposing inputs
        expect(r.repurposing_inputs.trials_availability.trials_present).toBe(true);
        expect(r.repurposing_inputs.trials_availability.trials_record_count).toBe(2);
        expect(r.repurposing_inputs.trials_availability.trial_links_record_count).toBe(1);
        expect(r.repurposing_inputs.neg_evidence_availability.neg_manifest_count).toBe(1);
        // candidate compounds: C1,C2,C3 (edges) -> 3.
        expect(r.repurposing_inputs.candidate_compound_count).toBe(3);

        // sizing (derived from the above)
        expect(r.sizing.posting_entry_count).toBe(4 + 3 + 3);
        expect(r.sizing.assumptions.note).toMatch(/ESTIMATES/);

        // (2) read-only verdict
        expect(r.verdict.put_count).toBe(0);
        expect(r.verdict.delete_count).toBe(0);
        expect(r.verdict.write_attempt_count).toBe(0);
        expect(r.verdict.read_only_clean).toBe(true);
        expect(r.verdict.snapshot_id_match).toBe(true);
        expect(r.verdict.probe_pass).toBe(true);
        expect(r.verdict.read_command_counts.get).toBeGreaterThan(0);
    });

    it('(3) drifted latest snapshot_id HARD FAILS (SnapshotDriftError)', async () => {
        const store = makeStore({ latest: latestBody({ snapshot_id: 'other/999-1' }) });
        const client = instrumentReadOnlyClient(makeMock(store));
        await expect(runSizingProbe(client, BUCKET, SNAPSHOT_ID)).rejects.toBeInstanceOf(SnapshotDriftError);
        // still read-only on the failure path.
        expect(client.put_count).toBe(0);
        expect(client.write_attempt_count).toBe(0);
    });
});

describe('RK16 reuses the read-only guard', () => {
    it('(4) the guard refuses a write command (Put)', async () => {
        const client = instrumentReadOnlyClient(makeMock(makeStore()));
        await expect(client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'x', Body: 'y' }))).rejects.toThrow(/READ-ONLY GUARD/);
        expect(client.put_count).toBe(1);
        expect(client.write_attempt_count).toBe(1);
    });
});
