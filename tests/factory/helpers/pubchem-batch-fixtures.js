/**
 * Shared fixtures for the PR-2 PubChem batch-harvest tests.
 *
 * Extracted per Art 5.1 250-line cap so pubchem-batch-harvest.test.ts (the
 * getCompoundsBatch core) and pubchem-batch-pass2.test.ts (the runBatchPass2
 * no-loss integration) share one fixture source. Pure (no vitest dep): each
 * test wraps the props/syns fns with vi.fn() locally when a call-count spy is
 * needed.
 */

import { normalize } from '../../../scripts/ingestion/adapters/pubchem-adapter.js';

// A raw PubChem property record (PropertyTable.Properties[] shape) for CID.
// InChIKey / MolecularFormula are crafted to satisfy COMPOUND_SCHEMA patterns.
export function rawFor(cid, overrides = {}) {
    return {
        CID: cid,
        MolecularFormula: 'C9H8O4',
        MolecularWeight: '180.16',
        IUPACName: `compound-${cid}`,
        InChI: `InChI=1S/C9H8O4/cid${cid}`,
        InChIKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
        SMILES: 'CC(=O)OC1=CC=CC=C1C(=O)O',
        XLogP: 1.2, TPSA: 63.6, Complexity: 212,
        HBondDonorCount: 1, HBondAcceptorCount: 4, RotatableBondCount: 3,
        ...overrides,
    };
}

export const synFor = cid => [`syn-${cid}-a`, `syn-${cid}-b`];

// Mask the 2 non-deterministic ISO timestamps for byte-identity comparison.
export function maskTs(entity) {
    const e = JSON.parse(JSON.stringify(entity));
    if (e?.provenance?.sources?.[0]) e.provenance.sources[0].timestamp = 'TS';
    if (e?.provenance) e.provenance.last_updated = 'TS';
    return e;
}

// A mock 200 PropertyTable response for the global-fetch single-CID path.
export function makeResponse(status, body = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => body,
    };
}

// Build injectable deps for getCompoundsBatch from a props fn (+ optional syns
// fn). Pass `wrap` (e.g. vi.fn) to make the legs spyable; defaults to identity.
export function makeDeps(propsFn, synsFn, wrap = f => f) {
    return {
        batchFetchProperties: wrap(async cids => propsFn(cids)),
        batchFetchSynonyms: wrap(async cids =>
            synsFn ? synsFn(cids) : new Map(cids.map(c => [String(c), synFor(c)]))),
        normalize,
    };
}
