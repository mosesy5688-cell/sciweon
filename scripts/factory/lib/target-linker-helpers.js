/**
 * Target Linker pure-function helpers (cycle 23 PR-SID-1.4-pre.1b).
 *
 * Extracted from scripts/factory/target-linker.js orchestrator so unit
 * tests can import without triggering main(). Same pattern as
 * lib/open-targets-sql.js ↔ open-targets-harvest.js separation.
 */

import { sanitizeUniprot } from './open-targets-target-sql.js';
import { TARGET_ID_PREFIX } from '../../../src/lib/schemas/target.js';

/**
 * Build initial target Map from OT records. One target per canonical
 * UniProt accession; OT record holds all metadata (approved_symbol etc.).
 * Multi-UniProt-per-record case: each canonical id gets its own target
 * entry (rare in protein_coding biotype but possible for fusion genes).
 */
export function buildOtTargetMap(otRecords, nowIso) {
    const targets = new Map();
    let skippedNoUniprot = 0;
    for (const ot of otRecords) {
        const ids = Array.isArray(ot.uniprot_canonical_ids) ? ot.uniprot_canonical_ids : [];
        if (ids.length === 0) { skippedNoUniprot++; continue; }
        for (const rawUniprot of ids) {
            const uniprot = sanitizeUniprot(rawUniprot);
            if (!uniprot) continue;
            if (targets.has(uniprot)) continue;
            targets.set(uniprot, buildOtTargetEntry(ot, uniprot, nowIso));
        }
    }
    return { targets, skippedNoUniprot };
}

function buildOtTargetEntry(ot, uniprot, nowIso) {
    return {
        id: `${TARGET_ID_PREFIX}uniprot:${uniprot}`,
        uniprot_accession: uniprot,
        ensembl_gene_id: ot.ensembl_gene_id ?? null,
        approved_symbol: ot.approved_symbol ?? null,
        approved_name: ot.approved_name ?? null,
        biotype: ot.biotype ?? null,
        uniprot_trembl_ids: Array.isArray(ot.uniprot_trembl_ids) ? ot.uniprot_trembl_ids : [],
        target_class: Array.isArray(ot.target_class) ? ot.target_class : [],
        db_xrefs: Array.isArray(ot.db_xrefs) ? ot.db_xrefs : [],
        synonyms: Array.isArray(ot.synonyms) ? ot.synonyms : [],
        symbol_synonyms: Array.isArray(ot.symbol_synonyms) ? ot.symbol_synonyms : [],
        function_descriptions: Array.isArray(ot.function_descriptions) ? ot.function_descriptions : [],
        subcellular_locations: Array.isArray(ot.subcellular_locations) ? ot.subcellular_locations : [],
        genomic_location: ot.genomic_location ?? null,
        // PR-UNIPROT-2a: organism is EVIDENCE-DERIVED, not a hardcoded human assertion.
        // OT target rows carry no organism field (the SQL is human-scoped, not organism-
        // stamped), so we no longer FABRICATE taxon 9606 here. organism stays null until
        // the PR-UNIPROT-2b UniProt accession-join supplies the real organism from the
        // SwissProt evidence (all-organism). [[evidence_not_verdict]]: do not assert what
        // the source row does not state.
        organism: null,
        provenance: {
            sources: [{
                source: 'open_targets',
                source_id: ot.ensembl_gene_id ?? null,
                timestamp: nowIso,
            }],
            last_updated: nowIso,
        },
    };
}

/**
 * Merge ChEMBL bioactivity targets into the target Map. UniProt-only
 * targets not in OT enter as skeleton records; existing OT targets get
 * a chembl_bioactivity provenance source appended (NOT a metadata field
 * overwrite — OT metadata wins).
 */
export function mergeBioactivityTargets(targets, bioactivityRecords, nowIso) {
    let added = 0;
    let appendedToExisting = 0;
    let skippedNoUniprot = 0;
    const augmentedKeys = new Set();
    for (const bio of bioactivityRecords) {
        const rawUniprot = bio?.target?.uniprot_accession;
        const uniprot = sanitizeUniprot(rawUniprot);
        if (!uniprot) { skippedNoUniprot++; continue; }
        if (targets.has(uniprot)) {
            if (augmentedKeys.has(uniprot)) continue;
            augmentedKeys.add(uniprot);
            const t = targets.get(uniprot);
            const hasChembl = t.provenance.sources.some(s => s.source === 'chembl_bioactivity');
            if (!hasChembl) {
                t.provenance.sources.push({
                    source: 'chembl_bioactivity',
                    source_id: bio.target.chembl_id ?? null,
                    timestamp: nowIso,
                });
                t.provenance.last_updated = nowIso;
                appendedToExisting++;
            }
            continue;
        }
        targets.set(uniprot, buildBioactivitySkeleton(uniprot, bio.target, nowIso));
        added++;
    }
    return { added, appendedToExisting, skippedNoUniprot };
}

function buildBioactivitySkeleton(uniprot, bioTarget, nowIso) {
    return {
        id: `${TARGET_ID_PREFIX}uniprot:${uniprot}`,
        uniprot_accession: uniprot,
        ensembl_gene_id: null,
        approved_symbol: bioTarget.gene_symbol ?? null,
        approved_name: bioTarget.protein_name ?? null,
        biotype: 'protein_coding',
        uniprot_trembl_ids: [], target_class: [], db_xrefs: [],
        synonyms: [], symbol_synonyms: [], function_descriptions: [],
        subcellular_locations: [], genomic_location: null,
        organism: bioTarget.organism ?? null,
        provenance: {
            sources: [{
                source: 'chembl_bioactivity',
                source_id: bioTarget.chembl_id ?? null,
                timestamp: nowIso,
            }],
            last_updated: nowIso,
        },
    };
}

export function parseJsonlBuffer(buf) {
    const records = [];
    for (const line of buf.toString('utf-8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { /* skip parse errors */ }
    }
    return records;
}
