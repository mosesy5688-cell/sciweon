// @ts-nocheck
/**
 * End-to-end coverage for streamDecompressForEach -- the generalized streaming zstd
 * decompress that replaced the spawnSync whole-buffer decompress (maxBuffer 256MB/1GB
 * -> ENOBUFS class) in the 5 sibling F3 linkers (mesh/snomed/loinc concept + disease +
 * target).
 *
 * The CONCEPT-LINKER path (build-an-INDEX over ALL records) was uncovered -- the only
 * prior IO-path test was uniprot's RETAIN-by-predicate (streamDecompressFilter). This
 * exercises the REAL spawn('zstd')+readline machinery against an in-test built .zst
 * fixture of concept-shaped JSONL records, with an onRecord that builds a Map (exactly
 * what the concept linkers do), and asserts: every record indexed, recordsSeen correct,
 * the leading `#` header skipped (hasHeader:true) and counted in headerSkipped, the
 * malformed-line contract under BOTH modes the family uses ('count' for the concept
 * linkers + disease + target; 'throw' = uniprot's hard-fail-with-index default), the
 * hasHeader:false path (disease/target bulks have NO header), and the loud-fail on a
 * corrupt/non-zst frame.
 *
 * NOTE (honesty): the fixture is a handful of concept-shaped records, NOT the real
 * ~301k-386k-record bulks (those cannot run on a dev box). It exercises the same
 * spawn+stdin+readline+exit-code machinery; the memory-bound property (never
 * materialize the decompressed corpus) is structural -- onRecord is invoked per line
 * and only the Map/array the caller retains lives in memory.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { streamDecompressForEach } from '../../scripts/factory/lib/stream-decompress-foreach.js';

// A UMLS concept record (lib/umls-concept-streams.js buildConceptRecord shape).
function conceptRec(code, sab = 'MSH') {
    return {
        code,
        cui: `C${code}`,
        sab,
        tty: 'PT',
        preferred_str: `concept ${code}`,
        synonyms: [`syn-${code}`],
        anchor_payload: `${sab}:${code}`,
        canonicalization_version: 'v1',
    };
}

const HEADER = '#' + JSON.stringify({ license_metadata: { source: 'umls_mesh', cui_withheld: true } });
const CONCEPTS = [conceptRec('D000001'), conceptRec('D000002'), conceptRec('D000003')];
const CONCEPT_JSONL = [HEADER, ...CONCEPTS.map(r => JSON.stringify(r))].join('\n') + '\n';

/** Build a real .zst buffer in-memory via the same zstd CLI the pipeline uses. */
function zstdCompress(str) {
    const r = spawnSync('zstd', ['-c', '--quiet'], { input: Buffer.from(str, 'utf-8'), maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`zstd fixture compress exit ${r.status}: ${r.stderr?.toString()}`);
    return r.stdout;
}

describe('streamDecompressForEach — REAL spawn(zstd)+readline, concept-linker INDEX-build path', () => {
    it('indexes EVERY record into a Map; header skipped (counted, not in recordsSeen)', async () => {
        const compressed = zstdCompress(CONCEPT_JSONL);
        const byCode = new Map();
        const { recordsSeen, headerSkipped, malformed } = await streamDecompressForEach(
            compressed, (rec) => { byCode.set(rec.code, rec); },
            { label: 'TEST-CONCEPT', hasHeader: true, onMalformed: 'count' });

        // recordsSeen counts the 3 data lines (the # header is excluded + counted separately).
        expect(recordsSeen).toBe(3);
        expect(headerSkipped).toBe(1);
        expect(malformed).toBe(0);
        // ALL concepts indexed by code, full record preserved (pass-through, no transform).
        expect([...byCode.keys()].sort()).toEqual(['D000001', 'D000002', 'D000003']);
        expect(byCode.get('D000002')).toEqual(conceptRec('D000002'));
    });

    it('records.length === recordsSeen matches the concept-linker count guard semantics', async () => {
        // Mirrors the concept linker: build records[] in onRecord, then assert
        // records.length === cursor.record_count. Here recordsSeen IS records.length.
        const compressed = zstdCompress(CONCEPT_JSONL);
        const records = [];
        const { recordsSeen } = await streamDecompressForEach(
            compressed, (rec) => { records.push(rec); },
            { label: 'TEST-CONCEPT', hasHeader: true, onMalformed: 'count' });
        expect(records.length).toBe(recordsSeen);
        expect(records.length).toBe(3);
    });

    it("onMalformed:'count' SKIPS a malformed line + counts it (concept linker throws iff malformed>0)", async () => {
        const corrupt = [HEADER, JSON.stringify(conceptRec('D000001')), '{ not json', JSON.stringify(conceptRec('D000003'))].join('\n') + '\n';
        const compressed = zstdCompress(corrupt);
        const records = [];
        const { recordsSeen, malformed } = await streamDecompressForEach(
            compressed, (rec) => { records.push(rec); },
            { label: 'TEST-CONCEPT', hasHeader: true, onMalformed: 'count' });
        // The 2 good records pass through; the bad line is counted, not thrown here.
        expect(records.map(r => r.code)).toEqual(['D000001', 'D000003']);
        expect(recordsSeen).toBe(2);
        expect(malformed).toBe(1);
        // Caller contract: malformed>0 => the linker HALTs (no short file). We assert the
        // count is surfaced so the caller CAN halt (the linkers do: `if (parseErrors>0) throw`).
        expect(malformed).toBeGreaterThan(0);
    });

    it("onMalformed:'throw' (uniprot default) HARD-FAILS with the 1-based record index", async () => {
        const corrupt = [HEADER, JSON.stringify(conceptRec('D000001')), '{ not json', JSON.stringify(conceptRec('D000003'))].join('\n') + '\n';
        const compressed = zstdCompress(corrupt);
        await expect(streamDecompressForEach(compressed, () => {}, { label: 'TEST', hasHeader: true, onMalformed: 'throw' }))
            .rejects.toThrow(/JSON parse error in bulk \(record #2\)/);
    });

    it('hasHeader:false (disease/target bulks) does NOT skip a leading data line', async () => {
        // OT disease/target bulks have NO # header -- every line is a data record.
        const noHeader = CONCEPTS.map(r => JSON.stringify(r)).join('\n') + '\n';
        const compressed = zstdCompress(noHeader);
        const records = [];
        const { recordsSeen, headerSkipped } = await streamDecompressForEach(
            compressed, (rec) => { records.push(rec); },
            { label: 'TEST-NOHDR', hasHeader: false, onMalformed: 'count' });
        expect(recordsSeen).toBe(3);
        expect(headerSkipped).toBe(0);
        expect(records.length).toBe(3);
    });

    it('blank lines are skipped (not counted as records)', async () => {
        const withBlank = [HEADER, JSON.stringify(conceptRec('D000001')), '', JSON.stringify(conceptRec('D000002'))].join('\n') + '\n';
        const compressed = zstdCompress(withBlank);
        let n = 0;
        const { recordsSeen } = await streamDecompressForEach(
            compressed, () => { n++; }, { label: 'TEST', hasHeader: true, onMalformed: 'count' });
        expect(recordsSeen).toBe(2);
        expect(n).toBe(2);
    });

    it('a non-zst/corrupt frame -> zstd exits non-zero -> throws LOUD (catches truncation)', async () => {
        const garbage = Buffer.from('this is not a zstd frame at all', 'utf-8');
        await expect(streamDecompressForEach(garbage, () => {}, { label: 'TEST', onMalformed: 'count' }))
            .rejects.toThrow(/zstd CLI exit/);
    });

    it('an onRecord throw is surfaced loud (not swallowed)', async () => {
        const compressed = zstdCompress(CONCEPT_JSONL);
        await expect(streamDecompressForEach(compressed, () => { throw new Error('boom'); },
            { label: 'TEST', hasHeader: true, onMalformed: 'count' }))
            .rejects.toThrow(/onRecord failed at record #1: boom/);
    });
});
