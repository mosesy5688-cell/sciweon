/**
 * Tests for V0.5.8 Wave C1-2 Phase 1 — entity-resolver.
 *
 * classifyIdentifier is pure (no I/O). resolveEntity needs a mocked R2
 * bucket for the slow-path scan; reuses the same makeMockBucket pattern
 * as tests/api/negative-evidence.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { classifyIdentifier, resolveEntity } from '../../src/worker/lib/entity-resolver';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

// xref-index-loader uses caches.default; Node has none -> always-miss shim.
beforeAll(() => {
    if (typeof (globalThis as any).caches === 'undefined') {
        (globalThis as any).caches = { default: { async match() { return undefined; }, async put() { } } };
    }
});

interface MockObject { bytes: Uint8Array; etag: string; }
function makeMockBucket(store: Record<string, MockObject>) {
    return {
        async head(key: string) {
            const o = store[key];
            if (!o) return null;
            return { size: o.bytes.length, etag: o.etag };
        },
        async get(key: string) {
            const o = store[key];
            if (!o) return null;
            return {
                etag: o.etag,
                async arrayBuffer() {
                    return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength);
                },
            };
        },
    } as unknown as R2Bucket;
}

describe('classifyIdentifier', () => {
    it('bare numeric -> pubchem_cid', () => {
        expect(classifyIdentifier('2244')).toEqual({ kind: 'pubchem_cid', normalized: '2244' });
    });

    it('CID: prefix -> pubchem_cid', () => {
        expect(classifyIdentifier('CID:2244')).toEqual({ kind: 'pubchem_cid', normalized: '2244' });
    });

    it('canonical form -> pubchem_cid', () => {
        expect(classifyIdentifier('sciweon::compound::CID:2244')).toEqual({
            kind: 'pubchem_cid', normalized: '2244',
        });
    });

    it('CHEMBL prefix -> chembl_id (normalized uppercase)', () => {
        expect(classifyIdentifier('CHEMBL25')).toEqual({ kind: 'chembl_id', normalized: 'CHEMBL25' });
        expect(classifyIdentifier('chembl25')).toEqual({ kind: 'chembl_id', normalized: 'CHEMBL25' });
    });

    it('27-char InChIKey -> inchi_key', () => {
        const ikey = 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N'; // aspirin
        expect(classifyIdentifier(ikey)).toEqual({ kind: 'inchi_key', normalized: ikey });
    });

    it('UNII: prefix -> unii', () => {
        expect(classifyIdentifier('UNII:R16CO5Y76E')).toEqual({ kind: 'unii', normalized: 'R16CO5Y76E' });
    });

    it('DB##### -> drugbank_id', () => {
        expect(classifyIdentifier('DB00945')).toEqual({ kind: 'drugbank_id', normalized: 'DB00945' });
    });

    it('CHEBI:n -> chebi_id (full normalized form)', () => {
        expect(classifyIdentifier('CHEBI:15365')).toEqual({ kind: 'chebi_id', normalized: 'CHEBI:15365' });
    });

    it('KEGG D-prefix and KEGG: prefix both work', () => {
        expect(classifyIdentifier('D00109')).toEqual({ kind: 'kegg_drug_id', normalized: 'D00109' });
        expect(classifyIdentifier('KEGG:D00109')).toEqual({ kind: 'kegg_drug_id', normalized: 'D00109' });
    });

    it('RXCUI: prefix -> rxcui', () => {
        expect(classifyIdentifier('RXCUI:1191')).toEqual({ kind: 'rxcui', normalized: '1191' });
    });

    it('rejects junk / empty / non-string', () => {
        expect(classifyIdentifier('not-a-real-id')).toBeNull();
        expect(classifyIdentifier('')).toBeNull();
        expect(classifyIdentifier(null)).toBeNull();
        expect(classifyIdentifier(undefined)).toBeNull();
        expect(classifyIdentifier(42)).toBeNull();
    });

    it('whitespace is trimmed', () => {
        expect(classifyIdentifier('  CHEMBL25  ')).toEqual({ kind: 'chembl_id', normalized: 'CHEMBL25' });
    });
});

describe('resolveEntity (with mock R2)', () => {
    const aspirinJsonl = JSON.stringify({
        id: 'sciweon::compound::CID:2244',
        pubchem_cid: 2244,
        chembl_id: 'CHEMBL25',
        inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        external_ids: {
            unii: 'R16CO5Y76E',
            drugbank_id: 'DB00945',
            chebi_id: 'CHEBI:15365',
            kegg_drug_id: 'D00109',
            rxcui: '1191',
        },
    });

    function bucket() {
        return makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-19' })),
                etag: 'p1',
            },
            'snapshots/2026-05-19/compounds-enriched.jsonl.gz': {
                bytes: gzipSync(aspirinJsonl),
                etag: 'd1',
            },
        });
    }

    it('resolves CID via fast path (no scan required)', async () => {
        const r = await resolveEntity(bucket(), 'CID:2244');
        expect(r).toEqual({
            canonical: 'sciweon::compound::CID:2244',
            cid: 2244,
            matched_on: 'pubchem_cid',
        });
    });

    it('resolves CHEMBL25 to aspirin via slow path', async () => {
        const r = await resolveEntity(bucket(), 'CHEMBL25');
        expect(r).toEqual({
            canonical: 'sciweon::compound::CID:2244',
            cid: 2244,
            matched_on: 'chembl_id',
        });
    });

    it('resolves InChIKey to aspirin', async () => {
        const r = await resolveEntity(bucket(), 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N');
        expect(r?.cid).toBe(2244);
        expect(r?.matched_on).toBe('inchi_key');
    });

    it('resolves UNII:R16CO5Y76E to aspirin via external_ids', async () => {
        const r = await resolveEntity(bucket(), 'UNII:R16CO5Y76E');
        expect(r?.cid).toBe(2244);
        expect(r?.matched_on).toBe('unii');
    });

    it('returns null for unknown identifier', async () => {
        const r = await resolveEntity(bucket(), 'CHEMBL99999999');
        expect(r).toBeNull();
    });

    it('returns null for unclassifiable input', async () => {
        const r = await resolveEntity(bucket(), 'not-a-real-id-format');
        expect(r).toBeNull();
    });
});

describe('resolveEntity via xref-index projection (PR-COMPOUND-GUARD)', () => {
    // The index partitions ALL 7 non-CID kinds; keys = classifyIdentifier's
    // normalized form. CID is NOT indexed (the resolver fast path never reads it).
    const xrefIndex = {
        version: '1.0', snapshot_date: '2026-05-19', generated_at: 'now', total_compounds: 1,
        index: {
            chembl_id: { CHEMBL25: 2244 },
            inchi_key: { 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N': 2244 },
            unii: { R16CO5Y76E: 2244 },
            drugbank_id: { DB00945: 2244 },
            chebi_id: { 'CHEBI:15365': 2244 },
            kegg_drug_id: { D00109: 2244 },
            rxcui: { 1191: 2244 },
        },
    };

    function indexedBucket(extra: Record<string, MockObject> = {}) {
        return makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-19' })),
                etag: 'p1',
            },
            'snapshots/2026-05-19/xref-index.json.gz': {
                bytes: gzipSync(JSON.stringify(xrefIndex)), etag: 'xi1',
            },
            // intentionally NO compounds-enriched -> proves the index path is used.
            ...extra,
        });
    }

    const allKinds: [string, string][] = [
        ['CHEMBL25', 'chembl_id'],
        ['BSYNRYMUTXBXSQ-UHFFFAOYSA-N', 'inchi_key'],
        ['UNII:R16CO5Y76E', 'unii'],
        ['DB00945', 'drugbank_id'],
        ['CHEBI:15365', 'chebi_id'],
        ['D00109', 'kegg_drug_id'],
        ['RXCUI:1191', 'rxcui'],
    ];

    for (const [raw, kind] of allKinds) {
        it(`resolves ${kind} (${raw}) via the index`, async () => {
            const r = await resolveEntity(indexedBucket(), raw);
            expect(r?.cid).toBe(2244);
            expect(r?.matched_on).toBe(kind);
        });
    }

    it('CID fast-path is unchanged (never reads the index file)', async () => {
        const r = await resolveEntity(indexedBucket(), 'CID:2244');
        expect(r).toEqual({ canonical: 'sciweon::compound::CID:2244', cid: 2244, matched_on: 'pubchem_cid' });
    });

    it('a kind miss in the index -> null (authoritative absence)', async () => {
        const r = await resolveEntity(indexedBucket(), 'CHEMBL999999');
        expect(r).toBeNull();
    });

    it('deploy-transition fallback: projection ABSENT (404) -> whole-file scan', async () => {
        // No xref-index.json.gz; the legacy compounds-enriched scan must resolve.
        const bucket = makeMockBucket({
            'snapshots/latest.json': {
                bytes: new TextEncoder().encode(JSON.stringify({ latest_snapshot_date: '2026-05-19' })),
                etag: 'p1',
            },
            'snapshots/2026-05-19/compounds-enriched.jsonl.gz': {
                bytes: gzipSync(JSON.stringify({
                    id: 'sciweon::compound::CID:2244', pubchem_cid: 2244, chembl_id: 'CHEMBL25',
                })),
                etag: 'd1',
            },
        });
        const r = await resolveEntity(bucket, 'CHEMBL25');
        expect(r?.cid).toBe(2244);
        expect(r?.matched_on).toBe('chembl_id');
    });
});
