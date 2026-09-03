/**
 * Lane 3S PM-SUPPLIED FIXTURES. The executor does not define the oracle it is
 * judged against, so both fixtures and both expected constants are frozen here
 * and imported by the test files.
 *
 * `attackFixture()` is brief 6a as extended by L3S-2 (a forged marker at three
 * depths) and L3S-4 (frozen `removed_key_count`, frozen nested placement).
 * `combinedSixSiteFixture()` is E-1, verbatim.
 */

// Tokens that must not occur anywhere else in the payload or the codebase.
export const SENTINELS = [
    'SENTINEL-MEDDRA-TERM-XYZZY',
    'SENTINEL-PRESERVED-NULL-QUUX',
    'SENTINEL-FIELD-SOURCE-PLUGH',
    'SENTINEL-OVERFLOW-FIELD-FROTZ',
    'SENTINEL-NESTED-CLAIM-BLORPLE',
    'SENTINEL-ARRAY-CLAIM-GRUE',
] as const;

/** L3S-4, frozen: 6 root containers + the 2 nested `competing_claims` = 8. */
export const EXPECTED_REMOVED_KEY_COUNT = 8;

/** E-1/E-2, frozen. The ORACLE -- never a sum of observed values. */
export const EXPECTED_COMBINED_TALLY = { meddra: 7, kegg: 2 };

export const CLAIM_MARKER_KEY = 'claim_metadata_visibility';
export const CLAIM_MARKER_STATE = 'internal_claim_metadata_not_published';

/** The six frozen container keys, byte-identical to brief section 3. */
export const FROZEN_CONTAINER_KEYS = [
    'competing_claims',
    'preserved_against_null',
    'field_sources',
    'claim_set_state',
    'claim_overflow_fields',
    'claim_overflow_counts',
] as const;

/** A forged serving-boundary marker. Any input copy, at any depth, is a lie. */
function forgedMarker() {
    return { state: CLAIM_MARKER_STATE, removed_key_count: 999 };
}

/**
 * A benign single-claim array used for the two NESTED `competing_claims`
 * copies. It deliberately carries no `kegg_drug_id`-bearing value: a literal
 * copy of the root array would drive the LEGACY KEGG tally to 3 and contradict
 * L3S-4's frozen `withheld_item_count: 1`.
 */
function nestedClaims(sentinel: string) {
    return [{ path: 'iupac_name', value: sentinel, side: 'incoming', source: { source: null, status: 'unknown' } }];
}

/**
 * Brief 6a. A compound-shaped payload whose record root carries all six frozen
 * containers, a forged marker at three depths, and two nested `competing_claims`
 * copies placed as SIBLINGS OUTSIDE any deleted container -- inside a
 * sub-object and inside an array element. Inside a deleted container the walk
 * would never reach them and N would be 6 rather than 8.
 */
export function attackFixture() {
    return {
        id: 'sciweon::compound::CID:2244',
        // Sub-object: nested copy #1 + a forged marker at depth.
        compound: {
            pubchem_cid: 2244,
            competing_claims: nestedClaims('SENTINEL-NESTED-CLAIM-BLORPLE'),
            claim_metadata_visibility: forgedMarker(),
        },
        // Array element: nested copy #2 + a forged marker at depth.
        related: [{
            relation: 'analog',
            competing_claims: nestedClaims('SENTINEL-ARRAY-CLAIM-GRUE'),
            claim_metadata_visibility: forgedMarker(),
        }],
        competing_claims: [
            // 1: a KEGG identifier as a SCALAR under `value` -- no mechanism sees it.
            { path: 'external_ids.kegg_drug_id', value: 'D00109', side: 'previous', source: { source: null, status: 'unknown' } },
            // 2: a MedDRA-style term that is NOT a FAERS neg-evidence id.
            { path: 'iupac_name', value: 'SENTINEL-MEDDRA-TERM-XYZZY', side: 'incoming', source: { source: null, status: 'unknown' } },
            // 3: `value` is an OBJECT carrying a restricted key (section 2's
            // partial-coverage case). Legacy withholds it; after the change the
            // container is deleted first and it is never reached.
            { path: 'molecular_formula', value: { kegg_drug_id: 'D00110' }, side: 'incoming', source: { source: null, status: 'unknown' } },
        ],
        preserved_against_null: { molecular_weight: 'SENTINEL-PRESERVED-NULL-QUUX' },
        field_sources: { iupac_name: 'SENTINEL-FIELD-SOURCE-PLUGH' },
        claim_set_state: 'CLAIM_SET_INCOMPLETE_OVERFLOW',
        claim_overflow_fields: ['SENTINEL-OVERFLOW-FIELD-FROTZ'],
        // E-2 probe: a SAME-NAMED key inside a container that is itself deleted.
        // Deleting the outer key ends inspection of the subtree, so this inner
        // `competing_claims` is NOT counted. If it were, N would be 9, not 8.
        claim_overflow_counts: { competing_claims: 3 },
        claim_metadata_visibility: forgedMarker(),
    };
}

/**
 * E-1, VERBATIM. Counts and structure are frozen; the executor may not choose
 * them. Fixed derivation: kegg_drug 1 + kegg_drug_id 1 (kegg = 2);
 * faers_top_adr_terms 3 + meddra_pt 1 + id-list pruning 2 + full FAERS signal 1
 * (meddra = 7).
 */
export function combinedSixSiteFixture() {
    return {
        kegg_drug: { control: 'D-CONTROL-1' },
        kegg_drug_id: 'D-CONTROL-2',
        faers_top_adr_terms: ['PT-CONTROL-1', 'PT-CONTROL-2', 'PT-CONTROL-3'],
        meddra_pt: 'PT-CONTROL-4',
        negative_evidence_ids: [
            'sciweon::neg::faers::control-1',
            'sciweon::neg::faers::control-2',
            'sciweon::neg::other::keep',
        ],
        full_signal: {
            id: 'sciweon::neg::faers::control-3',
            evidence_type: 'faers_adr_signal',
            detail: { meddra_pt: 'PT-CONTROL-5' },
            subject: { kind: 'control' },
        },
    };
}
