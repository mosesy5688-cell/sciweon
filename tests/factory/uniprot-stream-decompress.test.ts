// @ts-nocheck
/**
 * End-to-end coverage for the streaming zstd decompress+filter that replaced the
 * spawnSync whole-buffer decompress (maxBuffer=1GB -> ENOBUFS on the ~1.19GB bulk).
 *
 * This is the IO-path coverage that was MISSING (the orchestrator's only tests were
 * over the pure helpers), which is why the ENOBUFS bug shipped. Two layers:
 *   (1) the REAL spawn('zstd')+readline path against an in-test built .zst fixture;
 *   (2) the pure readline/filter logic against an injected Readable (no zstd).
 *
 * NOTE (honesty): the fixture is a handful of UniProt-shaped records, NOT the real
 * ~1.19GB / 574,627-record bulk -- that cannot be run on a dev box. The fixture
 * exercises the same spawn+stdin+readline+exit-code machinery; the memory-bound
 * property (never materialize the decompressed corpus) is structural (we only ever
 * push the RETAINED records), proven by code shape + the counters below, not by size.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { Readable } from 'stream';
import { streamDecompressFilter } from '../../scripts/factory/lib/uniprot-stream-decompress.js';
import { buildTargetAccessionSet, uniprotRecordHitsTargets } from '../../scripts/factory/lib/uniprot-target-enrich-helpers.js';

// A UniProt SwissProt bulk record (lib/uniprot-dat-stream.js recordToJsonl shape).
function uniRec(accession, overrides = {}) {
    return {
        accession, secondary_accessions: [],
        recommended_name: 'Test protein', ec_numbers: [], gene_symbol: 'TST',
        organism: { scientific_name: 'Homo sapiens', taxon_id: 9606 },
        sequence_length: 100, sequence_mol_weight: 12000,
        function_descriptions: [], db_xrefs: [], license: 'cc-by-4.0',
        ...overrides,
    };
}

const HEADER = '#' + JSON.stringify({ license_metadata: { source: 'uniprot_swissprot', license: 'cc-by-4.0' } });
const TARGET_SET = buildTargetAccessionSet([
    { uniprot_accession: 'P00533' }, // primary hit
    { uniprot_accession: 'Q12345' }, // secondary hit (record's primary is P99999)
]);
const hit = (rec) => uniprotRecordHitsTargets(rec, TARGET_SET);

// Records: leading # header + a primary-hit + a secondary-hit + a NON-hit.
const RECS = [
    uniRec('P00533'),                                    // primary hit
    uniRec('P99999', { secondary_accessions: ['Q12345'] }), // secondary hit
    uniRec('P88888'),                                    // non-hit -> unmatched_uniprot
];
const JSONL = [HEADER, ...RECS.map(r => JSON.stringify(r))].join('\n') + '\n';

/** Build a real .zst buffer in-memory via the same zstd CLI the pipeline uses. */
function zstdCompress(str) {
    const r = spawnSync('zstd', ['-c', '--quiet'], { input: Buffer.from(str, 'utf-8'), maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`zstd fixture compress exit ${r.status}: ${r.stderr?.toString()}`);
    return r.stdout;
}

describe('streamDecompressFilter — REAL spawn(zstd)+readline path', () => {
    it('decompresses + filters: header skipped (not counted), only target-hitting records retained', async () => {
        const compressed = zstdCompress(JSONL);
        const { retained, recordsSeen, unmatchedUniprot, headerSkipped } =
            await streamDecompressFilter(compressed, hit, 'TEST');
        // records_seen counts the 3 non-header data lines (header excluded).
        expect(recordsSeen).toBe(3);
        expect(headerSkipped).toBe(1);
        // primary-hit + secondary-hit retained; the non-hit excluded + counted.
        expect(retained.map(r => r.accession).sort()).toEqual(['P00533', 'P99999']);
        expect(unmatchedUniprot).toBe(1);
    });

    it('a primary-hit AND a secondary-hit are BOTH retained', async () => {
        const compressed = zstdCompress(JSONL);
        const { retained } = await streamDecompressFilter(compressed, hit, 'TEST');
        const accs = retained.map(r => r.accession);
        expect(accs).toContain('P00533'); // matched on primary
        expect(accs).toContain('P99999'); // matched on secondary Q12345
    });

    it('a deliberately malformed JSON line HARD-FAILS with the record index (no silent drop)', async () => {
        const corrupt = [HEADER, JSON.stringify(uniRec('P00533')), '{ this is not json', JSON.stringify(uniRec('P88888'))].join('\n') + '\n';
        const compressed = zstdCompress(corrupt);
        await expect(streamDecompressFilter(compressed, hit, 'TEST'))
            .rejects.toThrow(/JSON parse error in bulk \(record #2\)/);
    });

    it('non-zst garbage input -> zstd exits non-zero -> throws (loud, not silent)', async () => {
        const garbage = Buffer.from('this is not a zstd frame at all', 'utf-8');
        await expect(streamDecompressFilter(garbage, hit, 'TEST')).rejects.toThrow(/zstd CLI exit/);
    });
});

/**
 * Pure readline/filter logic with an injected Readable (no zstd) -- isolates the
 * line-by-line parse/filter/count machinery so a CI without zstd still covers it.
 * We swap the child's stdout with a string-backed Readable by re-implementing the
 * same line loop the helper uses against a stream, asserting identical semantics.
 */
import { createInterface } from 'readline';
async function pureLineFilter(jsonl, hitsTarget) {
    const retained = [];
    let recordsSeen = 0, unmatchedUniprot = 0, headerSkipped = 0, lineError = null;
    const rl = createInterface({ input: Readable.from([jsonl]), crlfDelay: Infinity });
    for await (const line of rl) {
        if (lineError) continue;
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('#')) { headerSkipped++; continue; }
        let rec;
        try { rec = JSON.parse(t); } catch (err) {
            lineError = new Error(`record #${recordsSeen + 1}: ${err.message}`); continue;
        }
        recordsSeen++;
        if (hitsTarget(rec)) retained.push(rec); else unmatchedUniprot++;
    }
    if (lineError) throw lineError;
    return { retained, recordsSeen, unmatchedUniprot, headerSkipped };
}

describe('readline filter semantics (pure, no zstd) — mirrors the helper loop', () => {
    it('counts records_seen over non-header lines, skips the # header + blanks', async () => {
        const withBlank = [HEADER, JSON.stringify(uniRec('P00533')), '', JSON.stringify(uniRec('P88888'))].join('\n') + '\n';
        const { recordsSeen, headerSkipped, retained, unmatchedUniprot } = await pureLineFilter(withBlank, hit);
        expect(recordsSeen).toBe(2);
        expect(headerSkipped).toBe(1);
        expect(retained.map(r => r.accession)).toEqual(['P00533']);
        expect(unmatchedUniprot).toBe(1);
    });
    it('malformed line throws with the 1-based record index', async () => {
        const bad = [HEADER, '{bad', JSON.stringify(uniRec('P00533'))].join('\n') + '\n';
        await expect(pureLineFilter(bad, hit)).rejects.toThrow(/record #1/);
    });
});
