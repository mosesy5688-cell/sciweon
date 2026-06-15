/**
 * RK-16C BIOACTIVITIES OFFLINE SPIKE — harness entrypoint (OFFLINE, no R2).
 *
 * A substrate-conformance + parameter-selection EXPERIMENT. It registers NO
 * family, touches NO production object / inventory / F4 / reader / latest / API
 * / wrangler, and produces NO activatable candidate. It loads the LOCAL
 * 2026-05-13 corpus + a SYNTHETIC heavy-hitter fixture, exercises the reused
 * A1/A2/A3 substrate, and writes results artifacts under results/.
 *
 *   node scripts/spikes/rk16c/run-spike.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCorpus, coverage, degrees } from './lib/corpus.mjs';
import { canonicalId } from './lib/policy.mjs';
import { buildCanonical } from './lib/build-axis.mjs';
import { runMatrix, PARSED_HEAP_CEILING } from './lib/param-matrix.mjs';
import {
    tmp, buildAxis, uniprotAliasCoverage, proveProjectionEquals, busiestGroup,
    runHeavyHitter, runPartitions, runRefIntegrity, runCodecGuard,
} from './lib/experiments.mjs';
import { renderMarkdown } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, 'results');
const SNAPSHOT_IDENTITY = '2026-05-13/rk16c-spike-1'; // offline label, NOT a prod id

/** Selected serving page policy (validated against the matrix below). */
const SELECTED = {
    record_count_target: 512,
    compressed_bytes_ceiling: 512 * 1024,
    parsed_heap_ceiling: PARSED_HEAP_CEILING,
};

async function main() {
    const out = {};

    const { rows: corpusRows, provenance } = loadCorpus();
    out.corpus_provenance = provenance;
    out.coverage = coverage(corpusRows);
    out.degree_distribution = {
        target_id: degrees(corpusRows, (r) => r.target_id),
        compound_id: degrees(corpusRows, (r) => r.compound_id),
        uniprot_accession: degrees(corpusRows, (r) => r.target && r.target.uniprot_accession),
    };

    // canonical authority — 1 record = 1 NXVF entity, stored once
    const { canon, byCanonicalId } = await buildCanonical(corpusRows, tmp('canon'));
    out.canonical = {
        record_total: canon.record_total, entity_count: canon.entity_count,
        canonical_once: canon.entity_count === corpusRows.length,
        key_example: `sciweon::bioactivity::<id> e.g. ${canonicalId(corpusRows[0])}`,
        shard_sha256: canon.shard_hashes[0],
    };

    // two materialized axes (compound + target; uniprot = alias only)
    const compoundAxis = await buildAxis(corpusRows, byCanonicalId, (r) => r.compound_id, SELECTED, 'compound');
    const targetAxis = await buildAxis(corpusRows, byCanonicalId, (r) => `chembl:${r.target_id}`, SELECTED, 'target');
    out.compound_axis = strip(compoundAxis);
    out.target_axis = strip(targetAxis);
    out.target_axis.uniprot_alias = uniprotAliasCoverage(corpusRows);

    // projection == project(canonical, policy)
    out.projection_equals_project = proveProjectionEquals(corpusRows, byCanonicalId);

    // parameter matrix on the busiest real target key
    const busiest = busiestGroup(targetAxis.proj, (r) => r.target_id);
    out.parameter_matrix = {
        subject: `busiest corpus target_id=${busiest.key} (degree ${busiest.rows.length})`,
        parsed_heap_ceiling_bytes: PARSED_HEAP_CEILING,
        seal_on_first_of: ['record_count', 'compressed_bytes', 'parsed_heap'],
        combos: await runMatrix(busiest.rows, tmp('matrix')),
        selected_candidate: {
            label: 'CORPUS-GROUNDED CANDIDATE',
            record_count_target: SELECTED.record_count_target,
            compressed_bytes_ceiling: SELECTED.compressed_bytes_ceiling,
            parsed_heap_ceiling: SELECTED.parsed_heap_ceiling,
            note: 'derived from 2026-05-13, 8,350 rows (smaller+older than production '
                + '475,112; no degree-43,364 target). Production-scale follow-up required.',
        },
    };

    out.heavy_hitter = await runHeavyHitter(SELECTED, SNAPSHOT_IDENTITY);
    out.partition_comparison = await runPartitions(busiest, SELECTED);
    out.referential_integrity = runRefIntegrity(targetAxis.proj, canon);

    // determinism — rebuild canonical -> identical bytes + hashes
    const rebuild = await buildCanonical(corpusRows, tmp('canon2'));
    out.determinism = {
        canonical_shard_byte_identical: Buffer.compare(canon.shard_bytes, rebuild.canon.shard_bytes) === 0,
        canonical_shard_sha256_match: canon.shard_hashes[0] === rebuild.canon.shard_hashes[0],
        matrix_all_deterministic: out.parameter_matrix.combos.every((c) => c.deterministic),
    };

    out.codec = runCodecGuard();

    writeArtifacts(out);
    console.log('[rk16c-spike] DONE — artifacts written to', RESULTS_DIR);
}

function strip(a) { const { proj, ...rest } = a; return rest; }

function writeArtifacts(out) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const json = JSON.stringify(out, null, 2);
    fs.writeFileSync(path.join(RESULTS_DIR, 'rk16c-spike-results.json'), json);
    fs.writeFileSync(
        path.join(RESULTS_DIR, 'RK16C_BIOACTIVITIES_OFFLINE_SPIKE_RESULTS.md'),
        renderMarkdown(out),
    );
}

main().catch((e) => { console.error(e); process.exit(1); });
