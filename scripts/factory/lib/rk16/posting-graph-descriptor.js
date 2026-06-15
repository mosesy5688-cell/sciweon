/**
 * RK-16A3 — 'posting_graph' family descriptor SHAPE + seal-binding helper.
 *
 * Kept in its OWN module (not snapshot-inventory.js / stage-4-activate.js) so
 * those core files stay under the CES Art 5.1 250-line cap. NO concrete
 * posting/graph family is registered anywhere — production STRUCTURED_INVENTORY
 * holds compounds/neg/xref/search ONLY, so the activation gate's posting_graph
 * branch is a NO-OP for every current candidate. Substrate-only; no I/O.
 */

/**
 * Build a 'posting_graph' family descriptor (used by tests to inject a fixture
 * family; production registers none). `derive(objectPrefix)` resolves the family
 * manifest key; `resolveShardKey(objectPrefix, shardKey)` maps a ref's shard_key
 * to a full object key (default `<prefix><shardKey>`); `attestationField` names
 * the manifest field holding the build-time referential-integrity attestation
 * hash the activation gate cross-checks against the seal.
 */
export function makePostingGraphDescriptor({
    id, derive, resolveShardKey, attestationField = 'referential_integrity_attestation_hash',
}) {
    if (!id || typeof derive !== 'function') {
        throw new Error('[posting-graph-descriptor] requires { id, derive(objectPrefix) }');
    }
    return Object.freeze({ id, kind: 'posting_graph', derive, resolveShardKey, attestationField });
}

/**
 * Build the `posting_family_attestations` seal sub-object from a list of
 * { id, attestation_hash } — bound into the seal ONLY when at least one posting
 * family is present (caller guards on length so the field is omitted otherwise,
 * keeping a current-shape candidate's sealCore byte-identical / hash unchanged).
 */
export function bindPostingFamilyAttestations(postingFamilies) {
    const attestations = {};
    for (const f of postingFamilies) {
        if (!f || !f.id || !f.attestation_hash) {
            throw new Error('[ACTIVATE] posting family seal binding requires { id, attestation_hash }');
        }
        attestations[f.id] = f.attestation_hash;
    }
    return attestations;
}
