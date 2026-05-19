/**
 * Tests for V0.5.8 Wave C1-2 Phase 1 — entity-resolver.
 *
 * classifyIdentifier is pure (no I/O). resolveEntity needs a mocked R2
 * bucket for the slow-path scan; reuses the same makeMockBucket pattern
 * as tests/api/negative-evidence.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { classifyIdentifier, resolveEntity } from '../../src/worker/lib/entity-resolver';

function gzipSync(text: string): Uint8Array {
    const { gzipSync: nodeGzip } = require('zlib');
    return new Uint8Array(nodeGzip(Buffer.from(text, 'utf-8')));
}

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
