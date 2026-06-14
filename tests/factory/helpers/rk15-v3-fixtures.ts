// @ts-nocheck
/**
 * RK-15 V3 test fixtures — a mock S3 client that EMULATES R2 conditional PUTs
 * + HEAD/GET, SEEDED with a complete 22-file Run #1 aggregated source so the
 * REAL V3-A producer path (publishCompoundShards/publishNegShards/...) runs
 * against it, plus the production-latest pointer the invariance/CAS checks need.
 * True R2 conditional honoring is confirmed live by the workflows; these lock
 * the CONTROL LOGIC + both write-GUARDs.
 */

import { createHash } from 'crypto';
import { AGGREGATED_FILES } from '../../../scripts/factory/lib/aggregated-files.js';
import { FIXED_SOURCE_PREFIX } from '../../../scripts/verify/rk15-v3-lib.js';

export const PROD_LATEST_KEY = 'snapshots/latest.json';

// A deterministic, high-entropy pad so the corpus genuinely splits into >=2 NXVF
// shards (the producer's split tracks the COMPRESSED on-disk size).
function bigField(seed: number, bytes: number) {
    let block = createHash('sha256').update(`rk15-v3-seed-${seed}`).digest();
    const parts: string[] = [];
    let acc = 0;
    while (acc < bytes) { block = createHash('sha256').update(block).digest(); const hex = block.toString('hex'); parts.push(hex); acc += hex.length; }
    return parts.join('').slice(0, bytes);
}

export const NAMED = [
    { pubchem_cid: 2244, inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N', chembl_id: 'CHEMBL25', external_ids: { unii: 'R16CO5Y76E', drugbank_id: 'DB00945' }, name: 'aspirin', pad: bigField(2244, 600_000) },
    { pubchem_cid: 3672, inchi_key: 'XEFQLINVKFYRCS-UHFFFAOYSA-N', chembl_id: 'CHEMBL521', external_ids: { unii: 'WK2XYI10QM', drugbank_id: 'DB01050' }, name: 'ibuprofen', pad: bigField(3672, 600_000) },
];
const FILLER = Array.from({ length: 44 }, (_, i) => {
    const cid = 900000 + i;
    return { pubchem_cid: cid, inchi_key: `FILLER${String(i).padStart(3, '0')}-UHFFFAOYSA-N`, chembl_id: `CHEMBLF${i}`, external_ids: {}, name: `filler-${i}`, pad: bigField(cid, 600_000) };
});
const ALL_COMPOUNDS = [...NAMED, ...FILLER];
const NEG = [
    { id: 'neg::1', subject: { compound_id: 'sciweon::compound::CID:2244' }, severity: 'major', evidence_type: 'fda_adverse_event', detail: 'aspirin signal' },
    { id: 'neg::2', subject: { compound_id: 'sciweon::compound::CID:3672' }, severity: 'minor', evidence_type: 'label_warning', detail: 'ibuprofen signal' },
    { id: 'neg::3', subject: { trial_id: 'NCT00000000' }, severity: 'critical', evidence_type: 'trial_termination', detail: 'trial signal' },
];

/** Build the 22-file Run #1 aggregated source content. The build-relevant files
 * (compounds/neg/search/xref + the SATELLITE serving files papers/trials/
 * trial-links/bioactivities/target-index) carry REAL reader-shaped content; the
 * remaining files are non-empty placeholders (present+non-empty is all V3-A
 * asserts of those). RK-15 full-snapshot completeness: the satellites are now
 * published by the candidate builder, so they must be reader-decodable lines. */
export function buildSourceBuffers() {
    const compounds = Buffer.from(ALL_COMPOUNDS.map(c => JSON.stringify(c)).join('\n'), 'utf-8');
    const neg = Buffer.from(NEG.map(n => JSON.stringify(n)).join('\n'), 'utf-8');
    const search = Buffer.from(NAMED.map(c => JSON.stringify({ cid: c.pubchem_cid, inchi_key: c.inchi_key, chembl_id: c.chembl_id, name: c.name })).join('\n'), 'utf-8');
    const xref = Buffer.from(JSON.stringify({ version: '1.0', routing: Object.fromEntries(NAMED.flatMap(c => [[c.chembl_id, c.pubchem_cid], [c.external_ids.unii, c.pubchem_cid], [c.external_ids.drugbank_id, c.pubchem_cid]].filter(([k]) => k))) }), 'utf-8');
    // Satellite serving content — reader-shaped (paper-loader/trial-loader/
    // bioactivity-loader/target-loader key derivations decode these).
    const papers = Buffer.from([
        { paper_id: 'PMID:1', mentioned_compounds: [{ compound_id: 'sciweon::compound::CID:2244' }] },
        { paper_id: 'PMID:2', mentioned_compounds: [{ compound_id: 'sciweon::compound::CID:3672' }] },
    ].map(p => JSON.stringify(p)).join('\n'), 'utf-8');
    const trialLinks = Buffer.from([
        { compound_id: 'sciweon::compound::CID:2244', nct_id: 'NCT00000001' },
    ].map(t => JSON.stringify(t)).join('\n'), 'utf-8');
    const trials = Buffer.from([
        { nct_id: 'NCT00000001', title: 'aspirin trial' },
    ].map(t => JSON.stringify(t)).join('\n'), 'utf-8');
    const bioactivities = Buffer.from([
        { id: 'bio::1', compound_id: 'sciweon::compound::CID:2244', target: { uniprot_accession: 'P23219' } },
    ].map(b => JSON.stringify(b)).join('\n'), 'utf-8');
    // target-index.json is a SINGLE JSON object (not jsonl) — a known target so a
    // legit 404 (target not in index) is NOT conflated with a missing index.
    const targetIndex = Buffer.from(JSON.stringify({
        version: '1.0', built_at: '2026-06-13T00:00:00Z',
        targets: { P23219: { uniprot_accession: 'P23219', protein_name: 'PTGS1', gene_symbol: 'PTGS1', chembl_target_id: 'CHEMBL221', organism: { taxon_id: 9606, scientific_name: 'Homo sapiens' }, compound_ids: ['sciweon::compound::CID:2244'], bioactivity_ids: ['bio::1'], trial_ids: [], negative_evidence_ids: [] } },
    }), 'utf-8');
    const buffers: Record<string, Buffer> = {};
    for (const f of AGGREGATED_FILES) buffers[f] = Buffer.from(`{"placeholder":"${f}"}`, 'utf-8');
    buffers['compounds-enriched.jsonl'] = compounds;
    buffers['neg-evidence.jsonl'] = neg;
    buffers['compounds-search.jsonl'] = search;
    buffers['xref-index.json'] = xref;
    buffers['papers.jsonl'] = papers;
    buffers['trial-links.jsonl'] = trialLinks;
    buffers['trials.jsonl'] = trials;
    buffers['bioactivities.jsonl'] = bioactivities;
    buffers['target-index.json'] = targetIndex;
    return buffers;
}

export function makeR2Mock(opts: any = {}) {
    const store = new Map<string, { body: any; etag: string }>();
    let seq = 0;
    function etagFor() { return `"e-${++seq}"`; }
    return {
        store,
        seed(key: string, body: any) { store.set(key, { body, etag: `"seed-${++seq}"` }); },
        async send(cmd: any) {
            const name = cmd.constructor.name;
            const { Key } = cmd.input;
            if (name === 'GetObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const buf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
                async function* gen() { yield buf; }
                return { ETag: o.etag, Body: gen() };
            }
            if (name === 'HeadObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e: any = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const len = Buffer.isBuffer(o.body) ? o.body.length : Buffer.byteLength(o.body);
                return { ETag: o.etag, ContentLength: len };
            }
            // PutObjectCommand
            const exists = store.get(Key);
            if (cmd.input.IfNoneMatch === '*' && exists && !opts.ignoreCreateOnly) {
                const e: any = new Error('At least one precondition failed: PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            if (cmd.input.IfMatch !== undefined && !opts.ignoreIfMatch && (!exists || exists.etag !== cmd.input.IfMatch)) {
                const e: any = new Error('PreconditionFailed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
            }
            store.set(Key, { body: cmd.input.Body, etag: etagFor() });
            return {};
        },
    };
}

/** Seed the complete 22-file Run #1 source into the mock at FIXED_SOURCE_PREFIX. */
export function seedSource(mock: any, buffers = buildSourceBuffers()) {
    for (const [fname, buf] of Object.entries(buffers)) mock.seed(`${FIXED_SOURCE_PREFIX}${fname}`, buf);
}

/** Seed a production latest pointer (the live legacy_v1 date-shape) so the
 * invariance check + the V3-B CAS have an object to act on. */
export function seedProdLatest(mock: any, date = '2026-06-01') {
    mock.seed(PROD_LATEST_KEY, JSON.stringify({ latest_snapshot_date: date }));
}
