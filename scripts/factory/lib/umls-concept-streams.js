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
 */
function toConceptRecord(entry) {
    return {
        code: entry.code,
        cui: entry.cui ?? null,
        sab: MESH_SAB,
        tty: entry.tty ?? null,
        preferred_str: entry.preferred_str ?? null,
        synonyms: [...entry.synonyms].sort(),
        anchor_payload: `${MESH_SAB}:${entry.code}`,
        canonicalization_version: MESH_CANONICALIZATION_VERSION,
    };
}

/**
 * Finalize the stream: emit a code-sorted concept array (byte-stable R2 artifact) + the
 * 3-SAB distinct-CODE counts (Set sizes) for the cursor + telemetry.
 */
export function finalizeConcepts(acc) {
    const concepts = [...acc.byCode.values()].map(toConceptRecord);
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
