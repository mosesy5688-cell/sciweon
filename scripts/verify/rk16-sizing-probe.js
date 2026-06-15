/**
 * RK-16 READ-ONLY SIZING PROBE -- entry / orchestration.
 *
 * Builds the REAL R2 client (the SAME makeR2Client the producer uses), wraps it
 * in the P8R1 read-only guard, binds the production snapshot (latest.json read
 * EXACTLY ONCE, snapshot_id asserted vs EXPECTED_SNAPSHOT_ID -> HARD FAIL on
 * drift), then STREAMS the served gz families under the pinned object_prefix to
 * compute the founder sizing report. It NEVER writes R2 / builds shards /
 * uploads benchmark artifacts (other than the evidence JSON) / changes latest /
 * modifies the reader/F4. The guard refuses any non-read command; put_count /
 * delete_count / write_attempt_count MUST be 0 for a pass.
 *
 * All sizing numbers are clearly-labeled ESTIMATES (inputs for a future real
 * spike), NOT measured shard bytes and NOT a substitute for building shards.
 */

import fs from 'fs/promises';
import path from 'path';
import { makeR2Client } from '../factory/lib/r2-stage-bridge.js';
import { instrumentReadOnlyClient } from './p8-r1-readonly-probe-lib.js';
import {
    bindSnapshot, headSize, scanPapers, scanPaperLinks, scanBioactivities,
    scanRepurposingInputs, SnapshotDriftError, DEFAULT_EXPECTED_SNAPSHOT_ID,
} from './rk16-sizing-probe-lib.js';
import {
    byteStats, degreeDistribution, distFromMap, unionEdgeCount, danglingEdgeCount,
    fraction, buildSizingEstimates, computeReadOnlyVerdict,
} from './rk16-sizing-metrics.js';

export async function runSizingProbe(client, bucket, expectedSnapshotId) {
    const bound = await bindSnapshot(client, bucket, expectedSnapshotId);
    const prefix = bound.object_prefix;

    // --- papers family (compressed bytes via HEAD; metrics via streaming) ---
    const papersCompressed = await headSize(client, bucket, `${prefix}papers.jsonl.gz`);
    const p = await scanPapers(client, bucket, prefix);
    const pl = await scanPaperLinks(client, bucket, prefix);
    const mentionDist = degreeDistribution(p.mentionDegree);
    const union = unionEdgeCount(pl.linkEdges, p.mentionEdges);
    const dangling = danglingEdgeCount(pl.linkEdges, p.paperIds);

    const papers = {
        compressed_bytes: papersCompressed,
        object_count: papersCompressed === null ? 0 : 1,
        record_count: p.recordBytes.length,
        record_bytes: byteStats(p.recordBytes),
        mentioned_compounds_degree_distribution: mentionDist.buckets,
        unique_paper_count: p.paperIds.size,
        paper_links_edge_count: union.paper_links_edge_count,
        union_edge_count: union.union_edge_count,
        dangling_edge_count: dangling,
    };

    // --- bioactivities family ---
    const bioCompressed = await headSize(client, bucket, `${prefix}bioactivities.jsonl.gz`);
    const b = await scanBioactivities(client, bucket, prefix);
    const compoundDist = degreeDistribution(b.compoundDegree);
    const targetDist = degreeDistribution(b.targetDegree);
    const bioactivities = {
        compressed_bytes: bioCompressed,
        record_count: b.rows,
        compound_cardinality: b.compoundDegree.size,
        target_id_cardinality: b.targetDegree.size,
        uniprot_coverage: fraction(b.withUniprot, b.rows),
        chembl_target_id_coverage: fraction(b.withTargetId, b.rows),
        per_compound_degree_distribution: compoundDist.buckets,
        per_target_degree_distribution: targetDist.buckets,
        is_active_distribution: distFromMap(b.isActive),
        activity_type_distribution: distFromMap(b.activityType),
    };

    // --- repurposing inputs (candidate set = union of compound endpoints) ---
    const repAvail = await scanRepurposingInputs(client, bucket, prefix);
    const candidateCompounds = new Set();
    for (const e of pl.linkEdges) candidateCompounds.add(e.compound_id);
    for (const e of p.mentionEdges) candidateCompounds.add(e.compound_id);
    for (const id of b.compoundDegree.keys()) candidateCompounds.add(id);
    const repurposing_inputs = {
        candidate_compound_count: candidateCompounds.size,
        candidate_compound_count_note: 'ESTIMATE: distinct compound_ids appearing as paper-link / mention / bioactivity endpoints in this snapshot (NOT a curated candidate list).',
        ...repAvail,
    };

    // --- sizing estimates (clearly labeled inputs) ---
    const sizing = buildSizingEstimates({
        papers_union_edge_count: papers.union_edge_count,
        bio_compound_edges: compoundDist.total_edges,
        bio_target_edges: targetDist.total_edges,
        max_compound_degree: compoundDist.max_degree,
        max_target_degree: targetDist.max_degree,
    });

    const verdict = computeReadOnlyVerdict(client, true);
    return { bound, papers, bioactivities, repurposing_inputs, sizing, verdict };
}

function buildEvidence(expectedSnapshotId, r) {
    return {
        probe: 'RK-16-SIZING',
        generated_at: new Date().toISOString(),
        estimates_disclaimer: 'Every value under `sizing` (and candidate_compound_count) is a labeled ESTIMATE / input for a future real spike -- NOT a measured shard byte, NOT a substitute for building shards.',
        expected_snapshot_id: expectedSnapshotId,
        snapshot: {
            snapshot_id: r.bound.snapshot_id,
            object_prefix: r.bound.object_prefix,
            layout_version: r.bound.layout_version,
        },
        papers: r.papers,
        bioactivities: r.bioactivities,
        repurposing_inputs: r.repurposing_inputs,
        sizing: r.sizing,
        read_command_counts: r.verdict.read_command_counts,
        put_count: r.verdict.put_count,
        delete_count: r.verdict.delete_count,
        write_attempt_count: r.verdict.write_attempt_count,
        read_only_clean: r.verdict.read_only_clean,
        snapshot_id_match: r.verdict.snapshot_id_match,
        probe_pass: r.verdict.probe_pass,
    };
}

async function writeEvidence(ev) {
    const outDir = process.env.RK16_OUTPUT_DIR || 'output';
    await fs.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, 'rk16-sizing-evidence.json');
    await fs.writeFile(out, JSON.stringify(ev, null, 2), 'utf-8');
    console.log(`[RK16-SIZING] evidence written: ${out}`);
}

async function main() {
    const bucket = process.env.R2_BUCKET;
    if (!bucket) throw new Error('R2_BUCKET not set');
    const expectedSnapshotId = process.env.EXPECTED_SNAPSHOT_ID || DEFAULT_EXPECTED_SNAPSHOT_ID;
    const client = instrumentReadOnlyClient(makeR2Client());

    try {
        const r = await runSizingProbe(client, bucket, expectedSnapshotId);
        const ev = buildEvidence(expectedSnapshotId, r);
        await writeEvidence(ev);
        console.log(`[RK16-SIZING] probe_pass=${r.verdict.probe_pass} snapshot_id=${r.bound.snapshot_id} papers_records=${r.papers.record_count} union_edges=${r.papers.union_edge_count} bio_records=${r.bioactivities.record_count} posting_entries=${r.sizing.posting_entry_count} put=${r.verdict.put_count} delete=${r.verdict.delete_count} write_attempt=${r.verdict.write_attempt_count} reads=${JSON.stringify(r.verdict.read_command_counts)}`);
        if (!r.verdict.probe_pass) process.exit(1);
    } catch (err) {
        // Safety-critical fact even on fatal: the guard let NOTHING write.
        const v = computeReadOnlyVerdict(client, false);
        const drift = err instanceof SnapshotDriftError;
        const ev = {
            probe: 'RK-16-SIZING', generated_at: new Date().toISOString(),
            expected_snapshot_id: expectedSnapshotId,
            fatal_error: String(err?.stack ?? err), snapshot_drift: drift,
            read_command_counts: v.read_command_counts, put_count: v.put_count,
            delete_count: v.delete_count, write_attempt_count: v.write_attempt_count,
            read_only_clean: v.read_only_clean, probe_pass: false,
        };
        await writeEvidence(ev);
        console.error(`[RK16-SIZING] FATAL${drift ? ' (SNAPSHOT DRIFT)' : ''}: ${String(err?.message ?? err)}`);
        console.log(`[RK16-SIZING] probe_pass=false put=${v.put_count} delete=${v.delete_count} write_attempt=${v.write_attempt_count} (fatal -- see evidence)`);
        process.exit(1);
    }
}

// Only auto-run as the entry script, not when imported by a test.
const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntry) {
    main().catch(err => {
        console.error(`[RK16-SIZING] UNHANDLED: ${String(err?.stack ?? err)}`);
        process.exit(1);
    });
}
