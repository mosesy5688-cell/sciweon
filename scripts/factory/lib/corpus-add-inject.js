/**
 * PR-MD-2c: pure UNII injection + Collar-B accounting for the corpus add (the
 * FIRST corpus mutation). The seed-corpus-add-compounds.js orchestration harvests
 * the resolvable CIDs through the validated, scope-gated PubChem path; this pure
 * core injects each compound's TARGET UNII u onto the freshly-linked baseline
 * record and reconciles added_n vs resolvable_n.
 *
 * COLLAR A (closed): u is injected here, at harvest time, BEFORE the F2/F3 enrich
 * cascade. Every downstream unii-writer is first-wins (UniChem fill-null
 * compound-id-resolver.js:81; FDA SRS keep-prior compound-fda-srs-enricher.js:87-95;
 * stage-3 deepMergeCompound non-null-preference, "UNII regression specifically
 * defended" aggregated-deep-merge.js:14-16; bulk rxnorm reads-unii-writes-rxcui
 * compound-rxnorm-enricher.js:90). So the injected u survives unchanged to the bulk
 * pre-pass, which stamps the target rxcui, and relink attaches drug_labels.
 *
 * COLLAR B (no silent attrition): a resolvable CID that the harvester dropped
 * (macromolecule_out_of_scope / no_property_record) is simply absent from the
 * baseline -> it lands in missing_cids, NOT silently lost. added_n is what actually
 * got u; dm_linked's rise reconciles to added_n, NOT resolvable_n.
 *
 * @param {Array} records  freshly-linked baseline compounds (each with pubchem_cid)
 * @param {Map} cidUniiMap  Map<cid(String), unii> from the resolvable list
 */
export function injectUniiAndAccount(records, cidUniiMap) {
    const map = cidUniiMap instanceof Map ? cidUniiMap : new Map();
    const presentCids = new Set();
    let added_n = 0;
    for (const r of records ?? []) {
        if (r?.pubchem_cid == null) continue;
        const cid = String(r.pubchem_cid);
        const u = map.get(cid);
        if (!u) continue;  // not a seed CID (should not happen; baseline == seeds)
        presentCids.add(cid);
        const ext = (r.external_ids && typeof r.external_ids === 'object') ? r.external_ids : { sources: [] };
        if (!Array.isArray(ext.sources)) ext.sources = [];
        ext.unii = u;  // seed injection: u is the authoritative UNII for this CID
        if (!ext.sources.includes('corpus_add_seed')) ext.sources.push('corpus_add_seed');
        r.external_ids = ext;
        added_n++;
    }
    const missing_cids = [...map.keys()].map(String).filter(c => !presentCids.has(c));
    return { added_n, resolvable_n: map.size, missing_cids };
}
