// @ts-nocheck
/**
 * RK-16C SPIKE — canonical-once + two-axis projection + projection==project +
 * seal-on-first-of-three. OFFLINE/FIXTURE; reuses A2 substrate + the spike
 * rk16c FamilyPolicy. NO family registered, NO production access.
 */
import { describe, it, expect } from 'vitest';
import { loadCorpus, corpusExists } from '../../scripts/spikes/rk16c/lib/corpus.mjs';
import {
    rk16cFamilyPolicy, compoundAxisKey, targetAxisKey, uniprotAliasKey, canonicalId,
} from '../../scripts/spikes/rk16c/lib/policy.mjs';
import { buildCanonical, projectRows, groupByKey } from '../../scripts/spikes/rk16c/lib/build-axis.mjs';
import { writeProjectionPages } from '../../scripts/factory/lib/rk16/projection-page-writer.js';
import { PARSED_HEAP_CEILING } from '../../scripts/spikes/rk16c/lib/param-matrix.mjs';

// CORPUS-GROUNDED: skip cleanly when the local corpus is absent (e.g. CI, where
// snapshots/ is gitignored). The synthetic heavy-hitter spec covers CI.
const hasCorpus = corpusExists();
const corpus = hasCorpus ? loadCorpus() : { rows: [] };
const sample = corpus.rows.slice(0, 800); // bounded subset keeps the test fast

describe.skipIf(!hasCorpus)('rk16c canonical authority', () => {
    it('1 record = 1 NXVF entity, stored once; key = the row id', async () => {
        const { canon } = await buildCanonical(sample, undefined, 'canon/shard-000.bin');
        expect(canon.entity_count).toBe(sample.length);
        expect(canon.record_total).toBe(sample.length);
        // canonical_id IS the row id (sciweon::bioactivity::<id>)
        expect(canon.record_locators[0].canonical_id).toBe(canonicalId(
            sample.find((r) => String(r.id) === canon.record_locators[0].canonical_id)));
        for (const loc of canon.record_locators) {
            expect(String(loc.canonical_id).startsWith('sciweon::bioactivity::')).toBe(true);
            expect(loc.content_hash).toMatch(/^[0-9a-f]{64}$/);
        }
    });
});

describe.skipIf(!hasCorpus)('rk16c two materialized axes', () => {
    it('compound + target axes; uniprot is an alias, NOT the authority', async () => {
        const { byCanonicalId } = await buildCanonical(sample, undefined);
        const proj = projectRows(sample, byCanonicalId);
        const compound = groupByKey(proj, (r) => compoundAxisKey({ compound_id: r.compound_id }));
        const target = groupByKey(proj, (r) => `chembl:${r.target_id}`);
        expect(compound.size).toBeGreaterThan(0);
        expect(target.size).toBeGreaterThan(0);
        // target_id is required (authority) on every row; uniprot only sometimes.
        const withTarget = sample.every((r) => r.target_id);
        expect(withTarget).toBe(true);
        const targetKey = targetAxisKey(sample[0]);
        expect(targetKey.startsWith('chembl:')).toBe(true);
        // uniprot alias resolves to the same target family ONLY when present.
        const withUni = sample.find((r) => r.target && r.target.uniprot_accession);
        if (withUni) expect(uniprotAliasKey(withUni).startsWith('uniprot:')).toBe(true);
        const withoutUni = sample.find((r) => !(r.target && r.target.uniprot_accession));
        if (withoutUni) expect(uniprotAliasKey(withoutUni)).toBeNull();
    });
});

describe.skipIf(!hasCorpus)('rk16c projection == project(canonical, policy)', () => {
    it('projection rows carry the required base fields and are a pure function', async () => {
        const { byCanonicalId } = await buildCanonical(sample, undefined);
        for (const r of sample.slice(0, 200)) {
            const loc = byCanonicalId.get(String(r.id));
            const a = rk16cFamilyPolicy.project(r, loc);
            const b = rk16cFamilyPolicy.project(r, loc);
            expect(a).toEqual(b); // deterministic / re-derivable
            expect(a.canonical_id).toBe(String(r.id));
            expect(a.canonical_content_hash).toBe(loc.content_hash);
            expect(a.projection_schema_version).toBe(rk16cFamilyPolicy.projection_schema_version);
            expect(a.record_locator).toEqual(loc);
            expect(a.projection_hash).toMatch(/^[0-9a-f]{64}$/);
            expect(a.target_id).toBe(String(r.target_id)); // serving field
        }
    });
});

describe.skipIf(!hasCorpus)('rk16c page writer seals on the FIRST of three ceilings', () => {
    async function rows(n) {
        const { byCanonicalId } = await buildCanonical(sample.slice(0, n), undefined);
        return projectRows(sample.slice(0, n), byCanonicalId);
    }
    it('seals on record_count first', async () => {
        const r = await rows(40);
        const res = await writeProjectionPages(r, {
            record_count_target: 10, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9,
        });
        expect(res.page_refs.every((p) => p.record_count <= 10)).toBe(true);
        expect(res.page_total).toBe(4);
    });
    it('seals on parsed_heap first', async () => {
        const r = await rows(60);
        const res = await writeProjectionPages(r, {
            record_count_target: 1000, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 2000,
        });
        expect(res.page_total).toBeGreaterThan(1);
    });
    it('seals on compressed_bytes first', async () => {
        const r = await rows(60);
        const res = await writeProjectionPages(r, {
            record_count_target: 1000, compressed_bytes_ceiling: 500, parsed_heap_ceiling: 1e9,
        });
        expect(res.page_total).toBeGreaterThan(1);
    });
    it('hard parsed-heap ceiling is the A1 4 MiB cap', () => {
        expect(PARSED_HEAP_CEILING).toBe(4 * 1024 * 1024);
    });
});
