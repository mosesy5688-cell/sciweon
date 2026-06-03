/**
 * Shared UMLS Metathesaurus concept-extraction lib (PR-UMLS-1).
 *
 * PURE + streaming-friendly: the harvest script (umls-harvest.js) streams MRCONSO.RRF
 * row-by-row through makeRrfParser(MRCONSO_COLUMNS) and calls ingestMrconsoRow per row.
 * Only a byCode Map + 3 distinct-CODE Sets stay resident -- the 2.34GB / 18,064,970-row
 * MRCONSO is NEVER buffer-loaded (verified, run 26749404603).
 *
 * Phase boundary (RATIFIED): PR-1 produces the ARTIFACT ONLY -- mesh-concepts.jsonl.zst
 * + a cursor + the 3-SAB distinct-CODE telemetry. PR-1 does NOT touch the SID ledger /
 * crosswalk / generator and asserts NO LANDED/LINKED claim. It DOES compute the SID-S
 * anchor fields into each record (like the disease *linker*, disease.js:103); the first
 * stamp / class auto-provision is PR-2.
 *
 * SID-S anchor (Correction 1, LOCKED): anchor_payload = `<SAB>:<CODE>` (content-addressed
 * code only -- NOT the mutable preferred string, NOT a semantic-label/random-UUID per
 * [[content_addressed_anchor_lock]]). CUI is carried as the CROSS-LINK anchor (the
 * cross-terminology bridge consumed in PR-2+), NOT the identity key -- we do NOT dedupe
 * CUI across SABs (cross-SAB CUI collision is INTENDED).
 */

import { TARGET_SABS } from './umls-mrconso-probe.js';
import { makeRrfParser } from './rxnorm-rrf-streams.js';

// MRCONSO column order -- verified from real rows, run 26749404603 (matches the UMLS doc;
// no RXNSAT-style swap). Each RRF line carries a TRAILING pipe -> csv-parse's
// relax_column_count:true absorbs the empty 19th field; these 18 names map 1:1.
export const MRCONSO_COLUMNS = [
    'CUI', 'LAT', 'TS', 'LUI', 'STT', 'SUI', 'ISPREF', 'AUI', 'SAUI', 'SCUI',
    'SDUI', 'SAB', 'TTY', 'CODE', 'STR', 'SRL', 'SUPPRESS', 'CVF',
];

// Single SSoT: the 3 SID-stamped target vocabularies live in umls-mrconso-probe.js.
export { TARGET_SABS };

export const MESH_SAB = 'MSH';
export const MESH_CANONICALIZATION_VERSION = 'mesh.concept.v1.0';

// PR-UMLS-3 SNOMED CT US harvest parameters. The same streaming core
// (ingestMrconsoRow / finalize) emits a SNOMED concept set when threaded with
// these; the SAB is EXACT-match (SNOMEDCT_US only -- SNOMEDCT_VET / other
// SNOMED editions are DISTINCT SABs and must NOT enter).
export const SNOMED_SAB = 'SNOMEDCT_US';
export const SNOMED_CANONICALIZATION_VERSION = 'snomed.concept.v1.0';

// PR-UMLS-4 LOINC harvest parameters (EXACT-match SAB=LNC). Distinct-LNC CODE count is
// MEASURED at harvest (upper bound 306,528, NOT assumed). NON-CONFLATION: LNC here is the
// UMLS LOINC *concept vocabulary* -- DISTINCT from spl-parser.js LOINC_SECTIONS (SPL
// document-section codes), a different axis that never joins.
export const LOINC_SAB = 'LNC';
export const LOINC_CANONICALIZATION_VERSION = 'loinc.concept.v1.0';

// Re-export the shared RRF csv-parse factory (named columns, NOT positional split;
// relax_column_count:true absorbs the trailing-pipe empty 19th field) from its SSoT in
// rxnorm-rrf-streams.js so the harvest + tests import it from one place.
export { makeRrfParser };

/**
 * Fresh streaming accumulator.
 *   byCode             Map<CODE, { code, cui, tty, preferredRank, preferred_str, synonyms:Set }>
 *                      -- one entry per distinct harvest-target CODE (atoms collapse here).
 *   distinctCodeBySab  per-target-SAB Set<CODE> -- the all-3 measurement, fed EVERY row
 *                      regardless of the harvest target (de-risks PR-3/PR-4 no-shard).
 */
export function newConceptAccumulator() {
    return {
        byCode: new Map(),
        distinctCodeBySab: { MSH: new Set(), SNOMEDCT_US: new Set(), LNC: new Set() },
    };
}

// Preferred-atom precedence. LOWER rank number = MORE preferred. A CODE with no preferred
// atom still yields rank 4 (first-seen fallback) -- never silent-drop a CODE per
// [[cross_cycle_silent_data_loss]].
function atomRank(row) {
    if (row.ISPREF === 'Y' && row.TS === 'P' && row.STT === 'PF') return 1;
    if (row.ISPREF === 'Y' && row.TS === 'P') return 2;
    if (row.TS === 'P') return 3;
    return 4;
}

/**
 * Ingest ONE parsed MRCONSO row. PURE (mutates + returns the passed accumulator);
 * unit-testable core of the harvest.
 *
 * Two independent passes per row:
 *  (1) ALWAYS: if row.SAB is a target SAB, add row.CODE to distinctCodeBySab[SAB]
 *      -- runs on every row regardless of targetSab (the 3-SAB de-risk measurement).
 *  (2) HARVEST branch: only when row.SAB === targetSab (EXACT match; MSHFRE/MSHSWE are
 *      DISTINCT SABs and must NOT enter), SUPPRESS === 'N', and LAT === 'ENG' (defensive
 *      English filter, PM-locked). Collapses atoms -> one concept per distinct CODE by
 *      preferred-atom precedence (replace current-best only on STRICTLY-higher rank;
 *      first-write-wins within a rank). ALL MSH record types kept (D/Q/C) -- NO TTY /
 *      CODE-prefix filter (full set per triple-lock; PR-2 chooses the join subset).
 */
export function ingestMrconsoRow(acc, row, targetSab) {
    if (!row) return acc;

    // (1) all-3-SAB distinct-CODE measurement (target-independent).
    const sab = row.SAB;
    if (sab && Object.prototype.hasOwnProperty.call(acc.distinctCodeBySab, sab) && row.CODE) {
        acc.distinctCodeBySab[sab].add(row.CODE);
    }

    // (2) harvest branch (exact SAB + suppress + English).
    if (sab !== targetSab) return acc;
    if (row.SUPPRESS !== 'N') return acc;
    if (row.LAT !== 'ENG') return acc;
    const code = row.CODE;
    if (!code) return acc;

    const str = row.STR ?? '';
    const rank = atomRank(row);
    const existing = acc.byCode.get(code);
    if (!existing) {
        const synonyms = new Set();
        acc.byCode.set(code, {
            code, cui: row.CUI, tty: row.TTY, preferredRank: rank, preferred_str: str, synonyms,
        });
        return acc;
    }
    if (rank < existing.preferredRank) {
        // New strictly-better preferred atom: the old preferred string becomes a synonym.
        if (existing.preferred_str && existing.preferred_str !== str) {
            existing.synonyms.add(existing.preferred_str);
        }
        existing.preferredRank = rank;
        existing.preferred_str = str;
        existing.cui = row.CUI;
        existing.tty = row.TTY;
        existing.synonyms.delete(str);
    } else if (str && str !== existing.preferred_str) {
        // Non-preferred (or equal-rank) ENG atom -> synonym set.
        existing.synonyms.add(str);
    }
    return acc;
}

/**
 * Build the one-JSONL-line-per-distinct-CODE concept record. anchor_payload mirrors
 * disease.js:103's `<namespace>:<suffix>` shape -- computed here (the SID-S input),
 * NOT hashed (PR-1 does not stamp). canonicalization_version is the migration lever.
 *
 * PR-UMLS-3: parameterized on (sab, canon). Defaults to MeSH (MSH /
 * mesh.concept.v1.0) so the existing MeSH harvest is UNCHANGED; the SNOMED
 * harvest threads SNOMED_SAB + SNOMED_CANONICALIZATION_VERSION. The anchor_payload
 * stays `<SAB>:<CODE>` content-addressed (Correction 1) for whichever SAB is active.
 */
function toConceptRecord(entry, sab = MESH_SAB, canon = MESH_CANONICALIZATION_VERSION) {
    return {
        code: entry.code,
        cui: entry.cui ?? null,
        sab,
        tty: entry.tty ?? null,
        preferred_str: entry.preferred_str ?? null,
        synonyms: [...entry.synonyms].sort(),
        anchor_payload: `${sab}:${entry.code}`,
        canonicalization_version: canon,
    };
}

/**
 * Finalize the stream: emit a code-sorted concept array (byte-stable R2 artifact) + the
 * 3-SAB distinct-CODE counts (Set sizes) for the cursor + telemetry.
 *
 * PR-UMLS-3: (sab, canon) default to MeSH (no MeSH regression); the SNOMED harvest
 * passes finalizeConcepts(acc, SNOMED_SAB, SNOMED_CANONICALIZATION_VERSION).
 */
export function finalizeConcepts(acc, sab = MESH_SAB, canon = MESH_CANONICALIZATION_VERSION) {
    const concepts = [...acc.byCode.values()].map(e => toConceptRecord(e, sab, canon));
    concepts.sort((a, b) => a.code.localeCompare(b.code));
    return {
        concepts,
        distinctCodeBySab: {
            MSH: acc.distinctCodeBySab.MSH.size,
            SNOMEDCT_US: acc.distinctCodeBySab.SNOMEDCT_US.size,
            LNC: acc.distinctCodeBySab.LNC.size,
        },
    };
}

// NLM attribution (reused verbatim from rxnorm-harvest.js ATTRIBUTION).
export const NLM_ATTRIBUTION = 'This product uses publicly available data courtesy of the U.S. National Library of Medicine (NLM). NLM is not responsible for the product and does not endorse or recommend this or any other product.';

/**
 * MeSH license_metadata. Bulk tracker #47 is the license SSoT (UMLS Metathesaurus, CAT0 =
 * no additional restrictions; MeSH itself is NLM public-domain). Mirrors the
 * rxnorm-harvest.js header shape.
 */
export function buildMeshLicenseMetadata(release, ingestionDate) {
    return {
        upstream_source: 'umls_metathesaurus',
        upstream_license: 'umls_cat0',
        extracted_content: 'msh_concepts(code+cui+preferred_str+synonyms)',
        upstream_release: release,
        ingestion_date: ingestionDate,
        attribution: NLM_ATTRIBUTION,
    };
}

/**
 * SNOMED CT US license_metadata (PR-UMLS-3). Bulk tracker #47 is the SSoT; SNOMED CT is
 * SNOMED Affiliate / UMLS Metathesaurus redistribution-RESTRICTED (CAT3-class, NOT CAT0 like
 * MeSH). RULING 1 + RULING 2 (founder, NON-NEGOTIABLE): the FULL STR+CODE+CUI artifact this
 * metadata accompanies is INTERNAL-ONLY (R2 internal/ prefix); the PUBLIC snapshot exposes
 * ZERO SNOMED proprietary content -- only Sciweon-produced SID hashes + provenance. The
 * redistribution gate is enforced in the publishing boundary (snomed-public-projection.js +
 * SNAPSHOT_FILES omission), NOT here; this metadata is the audit trail on the internal file.
 */
export function buildSnomedLicenseMetadata(release, ingestionDate) {
    return {
        upstream_source: 'umls_metathesaurus',
        upstream_license: 'snomed_ct_affiliate',
        extracted_content: 'snomedct_us_concepts(code+cui+preferred_str+synonyms)',
        redistribution: 'internal_only_full_artifact_public_snapshot_is_sid_hashes_only',
        upstream_release: release,
        ingestion_date: ingestionDate,
        attribution: NLM_ATTRIBUTION,
    };
}

/**
 * Regenstrief LOINC attribution (PR-UMLS-4, founder-locked VERBATIM). The LOINC license
 * REQUIRES this exact notice. It rides into the TWO real public-facing layers PR-UMLS-4
 * produces: the loinc-concepts-public.jsonl metadata header (loinc-public-builder.js) + the
 * snapshot manifest license_notices block (snapshot-builder.js). The (c)/(R) signs are
 * intentional UTF-8 literals (Latin-1 supplement, NOT CJK -- CES English-mandate-safe).
 */
export const LOINC_ATTRIBUTION = 'This product includes all or a portion of the LOINC table and/or LOINC codes, or LOINC panels and forms, which are copyright © 1995-2026, Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee and are available at no cost under the license at loinc.org/license. LOINC® is a registered United States trademark of Regenstrief Institute, Inc.';

/**
 * LOINC license_metadata (PR-UMLS-4). Bulk tracker #47 is the SSoT; LOINC code+str are
 * redistributable at NO COST under the Regenstrief license (Cat-0-like -- KEPT in the public
 * projection) while the NLM-proprietary CUI is ALWAYS dropped. Mirrors buildSnomedLicenseMetadata
 * but Cat-0 + carries the verbatim Regenstrief notice in `loinc_attribution`. The full
 * STR+CODE+CUI artifact this accompanies is INTERNAL-ONLY; the public snapshot gets the Cat-0
 * projection {sid_s,sid_c,code,str} via projectUmlsPublic('LOINC',...) + SNAPSHOT_FILES omission.
 */
export function buildLoincLicenseMetadata(release, ingestionDate) {
    return {
        upstream_source: 'umls_metathesaurus',
        upstream_license: 'loinc_regenstrief_no_cost',
        extracted_content: 'lnc_concepts(code+cui+preferred_str+synonyms)',
        redistribution: 'internal_full_artifact_public_snapshot_is_cat0_sid_code_str_no_cui',
        upstream_release: release,
        ingestion_date: ingestionDate,
        attribution: NLM_ATTRIBUTION,
        loinc_attribution: LOINC_ATTRIBUTION,
    };
}
