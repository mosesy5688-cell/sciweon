// @ts-nocheck
/**
 * RK-16A3 test fixture — build a COMPLETE posting/graph family with the A2 writers
 * (canonical shards + projection pages + a two-level directory) + a CLEAN
 * referential-integrity attestation, and seed a mock R2 store so the activation
 * graph probe can walk it. PURE FIXTURE: no business policy, no real family.
 */

import { writeCanonicalShardAsync } from '../../../scripts/factory/lib/rk16/canonical-shard-writer.js';
import { writeProjectionPages } from '../../../scripts/factory/lib/rk16/projection-page-writer.js';
import { writePostingList } from '../../../scripts/factory/lib/rk16/posting-directory-writer.js';
import { attestReferentialIntegrity } from '../../../scripts/factory/lib/rk16/referential-integrity.js';
import { makeCanonicalRecords, fixtureFamilyPolicy } from './_fixture-family.js';

export const FAMILY_ID = 'fixture_graph';

/** Mock R2: GET only (the graph probe is read-only). Returns { store, send }. */
export function makeGraphMock() {
    const store = new Map();
    return {
        store,
        seed(key, body) { store.set(key, { body }); },
        async send(cmd) {
            const name = cmd.constructor.name;
            const { Key } = cmd.input;
            if (name === 'GetObjectCommand') {
                const o = store.get(Key);
                if (!o) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                const buf = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
                async function* gen() { yield buf; }
                return { Body: gen() };
            }
            throw new Error(`graph mock: unexpected ${name}`);
        },
    };
}

/**
 * Build the family fixture. `n` canonical records -> N projection rows -> pages
 * (forced to multiple by record_count_target) -> two-level directory.
 * Returns { mock, prefix, descriptor, seal, manifestKey, attestationHash,
 *   canonShardKey, projShardKey, dirShardKey, manifest }.
 */
export async function buildGraphFamilyFixture({ prefix = 'snapshots/2026-06-15/700-1/', n = 8 } = {}) {
    const records = makeCanonicalRecords(n);
    const canonShardKey = 'fixture_graph/canonical/shard-000.bin';
    const canon = await writeCanonicalShardAsync(records, { shardKey: canonShardKey });

    const rows = canon.record_locators.map((loc) => {
        const o = records.find((r) => r.canonical_id === loc.canonical_id);
        return fixtureFamilyPolicy.project(o.record, loc);
    });
    const projShardKey = 'fixture_graph/projection/shard-000.bin';
    // record_count_target=1 -> one page per row -> >64 pages would force a directory,
    // but n is small; we wrap with writePostingList which goes two-level only when
    // over threshold. To exercise BOTH levels deterministically we pad page refs.
    const proj = await writeProjectionPages(rows, { record_count_target: 1, compressed_bytes_ceiling: 1e9, parsed_heap_ceiling: 1e9 }, { shardKey: projShardKey });

    // Force a two-level directory by padding the real page refs up past the cap
    // with copies of the FIRST page ref (the probe only walks index 0, which is real).
    const padded = [...proj.page_refs];
    while (padded.length <= 64) padded.push({ ...proj.page_refs[0] });
    const dirShardKey = 'fixture_graph/directory/shard-000.bin';
    const dir = await writePostingList(padded, { directoryShardKey: dirShardKey });

    // Build a CLEAN attestation over the rows (every locator resolves).
    const byId = new Map(canon.record_locators.map((l) => [l.canonical_id, l]));
    const attestation = attestReferentialIntegrity(rows, (loc) => byId.get(loc.canonical_id));
    const attestationHash = attestation.referential_integrity_attestation_hash;

    const manifestKey = `${prefix}fixture_graph/manifest.json`;
    const manifest = {
        family_id: FAMILY_ID,
        referential_integrity_attestation_hash: attestationHash,
        sample_posting: { index_key: 'sample', posting_list: dir.posting_list },
    };

    const mock = makeGraphMock();
    mock.seed(manifestKey, JSON.stringify(manifest));
    mock.seed(`${prefix}${canonShardKey}`, canon.shard_bytes);
    mock.seed(`${prefix}${projShardKey}`, proj.shard_bytes);
    mock.seed(`${prefix}${dirShardKey}`, dir.directory_bytes);

    const descriptor = {
        id: FAMILY_ID, kind: 'posting_graph',
        derive: (p) => `${p}fixture_graph/manifest.json`,
        resolveShardKey: (p, shardKey) => `${p}${shardKey}`,
        attestationField: 'referential_integrity_attestation_hash',
    };
    const seal = { posting_family_attestations: { [FAMILY_ID]: attestationHash } };

    return {
        mock, prefix, descriptor, seal, manifestKey, attestationHash, manifest,
        canonShardKey: `${prefix}${canonShardKey}`,
        projShardKey: `${prefix}${projShardKey}`,
        dirShardKey: `${prefix}${dirShardKey}`,
        proj, canon, dir,
    };
}
