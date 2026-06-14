/**
 * RK-15 V2 — deterministic tiny fixture builder.
 *
 * Produces, ON DISK, a small-but-COMPLETE corpus covering EVERY snapshot object
 * class so a real publish exercises all of them and validateCandidate's
 * required_inventory checks them all:
 *   - a compounds-enriched.jsonl that packs into >=2 real NXVF compound shards
 *     (via the production compound-shard-publisher / shard-writer);
 *   - a neg-evidence.jsonl that produces a neg manifest + >=1 neg shard (via the
 *     production neg-shard-publisher);
 *   - an xref/routing object (xref-index.json.gz);
 *   - the search/entity required-inventory object (compounds-search.jsonl.gz).
 * (The seal/metadata object is written by buildAndSealCandidate at publish time.)
 *
 * Determinism (Constitution V16.1 §7): a fixed corpus + the producers' stable
 * sort + deterministic zstd => byte-reproducible shards => stable sha256.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { SATELLITE_INVENTORY } from '../factory/lib/snapshot-inventory.js';

// Deterministic, CRYPTOGRAPHICALLY-INCOMPRESSIBLE filler. The shard SPLIT
// decision tracks the COMPRESSED on-disk size (ShardWriter zstd-compresses each
// entity), so a compressible pad would never grow a shard past the producer's
// 10MB cap and the corpus would never split. A seeded SHA-256 keystream (each
// block = hash of the previous block) is high-entropy -> zstd cannot shrink it,
// so the cumulative on-disk size genuinely crosses 10MB and the REAL packShards
// (no opts override) emits >=2 NXVF shards. Fully seeded => byte-reproducible.
function bigField(seed, bytes) {
    let block = createHash('sha256').update(`rk15-v2-seed-${seed}`).digest();
    const parts = [];
    let acc = 0;
    while (acc < bytes) {
        block = createHash('sha256').update(block).digest();
        const hex = block.toString('hex'); // 64 hex chars/block, valid JSON content
        parts.push(hex);
        acc += hex.length;
    }
    return parts.join('').slice(0, bytes);
}

// The two NAMED compounds the serving check resolves by CID. They carry a
// modest deterministic pad each (zstd-friendly; the WASM codec handles it).
export const FIXTURE_COMPOUNDS = [
    { pubchem_cid: 2244, inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N', chembl_id: 'CHEMBL25', external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945' }, name: 'aspirin', pad: bigField(2244, 600_000) },
    { pubchem_cid: 3672, inchi_key: 'XEFQLINVKFYRCS-UHFFFAOYSA-N', chembl_id: 'CHEMBL521', external_ids: { unii: 'WK2XYI10QM', drugbank_id: 'DB01050' }, name: 'ibuprofen', pad: bigField(3672, 600_000) },
];

// Filler compounds (deterministic) so the corpus's CUMULATIVE raw size exceeds
// the producer's 10MB MAX_SHARD_BYTES and the REAL packShards (no opts override)
// splits it into >=2 NXVF shards. 18 x 600KB + the 2 named = ~12MB raw -> 2 shards.
// Each entity is zstd-compressed individually (WASM-safe), so on-disk shards stay
// tiny while the SPLIT boundary (raw size) is genuinely crossed.
const FILLER_COUNT = 44;
const FILLER = Array.from({ length: FILLER_COUNT }, (_, i) => {
    const cid = 900000 + i;
    return { pubchem_cid: cid, inchi_key: `FILLER${String(i).padStart(3, '0')}-UHFFFAOYSA-N`, chembl_id: `CHEMBLF${i}`, external_ids: {}, name: `filler-${i}`, pad: bigField(cid, 600_000) };
});
const ALL_COMPOUNDS = [...FIXTURE_COMPOUNDS, ...FILLER];

// A small neg-evidence corpus: a compound signal, a trial signal, and an orphan
// paper retraction — exercises distinct neg routing keys + a real neg shard.
export const FIXTURE_NEG = [
    { id: 'neg::1', subject: { compound_id: 'sciweon::compound::CID:2244' }, severity: 'major', evidence_type: 'fda_adverse_event', detail: 'fixture aspirin signal' },
    { id: 'neg::2', subject: { compound_id: 'sciweon::compound::CID:3672' }, severity: 'minor', evidence_type: 'label_warning', detail: 'fixture ibuprofen signal' },
    { id: 'neg::3', subject: { trial_id: 'NCT00000000' }, severity: 'critical', evidence_type: 'trial_termination', detail: 'fixture trial signal' },
    { id: 'neg::4', subject: {}, paper_id: 'PMID:00000000', severity: 'unknown', evidence_type: 'paper_retraction', detail: 'fixture orphan retraction' },
];

/**
 * Materialize the fixture under a fresh temp dir. Returns the on-disk paths +
 * an in-memory description of the corpus the harness asserts against. Small
 * maxShardBytes is returned so the caller forces a >=2-shard split deterministically.
 */
export async function buildFixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rk15-v2-fixture-'));

    const compoundsJsonl = path.join(dir, 'compounds-enriched.jsonl');
    await fs.writeFile(compoundsJsonl, ALL_COMPOUNDS.map(c => JSON.stringify(c)).join('\n'), 'utf-8');

    const negJsonl = path.join(dir, 'neg-evidence.jsonl');
    await fs.writeFile(negJsonl, FIXTURE_NEG.map(n => JSON.stringify(n)).join('\n'), 'utf-8');

    // The serving-projection + xref/routing objects are gzipped jsonl/json (the
    // reader inventory requires them present + non-empty). Deterministic content.
    const searchLines = FIXTURE_COMPOUNDS.map(c => JSON.stringify({
        cid: c.pubchem_cid, inchi_key: c.inchi_key, chembl_id: c.chembl_id, name: c.name,
    })).join('\n');
    const searchGz = zlib.gzipSync(Buffer.from(searchLines, 'utf-8'), { level: 9 });

    const xrefObj = {
        version: '1.0',
        generated_for: 'rk15-v2-fixture',
        routing: Object.fromEntries(FIXTURE_COMPOUNDS.flatMap(c => [
            [c.chembl_id, c.pubchem_cid],
            [c.external_ids.unii, c.pubchem_cid],
            [c.external_ids.drugbank_id, c.pubchem_cid],
        ].filter(([k]) => k))),
    };
    const xrefGz = zlib.gzipSync(Buffer.from(JSON.stringify(xrefObj), 'utf-8'), { level: 9 });

    // RK-15 full-snapshot completeness: validateCandidate now decode-probes EVERY
    // SSoT-required SATELLITE serving file at the candidate prefix. The V2 publish
    // path must therefore publish a reader-decodable gz for each (the real F4
    // snapshot-builder does the equivalent). Deterministic stub content suffices —
    // this harness asserts the identity/CAS contract, not satellite content parity.
    const satelliteBytes = {};
    for (const e of SATELLITE_INVENTORY) {
        satelliteBytes[e.key_suffix] = zlib.gzipSync(
            Buffer.from(JSON.stringify({ ok: true, file: e.snapshot_file }) + '\n', 'utf-8'), { level: 9 });
    }

    return {
        dir,
        compoundsJsonl,
        negJsonl,
        searchProjectionBytes: searchGz,
        xrefIndexBytes: xrefGz,
        satelliteBytes,
        // Classes the harness must observe in the published inventory.
        objectClasses: [
            'compounds_manifest', 'compounds_shards', 'neg_manifest', 'neg_shards',
            'xref_index', 'search_projection', 'satellites', 'root_seal',
        ],
    };
}
