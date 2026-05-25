/**
 * SAL OT clinical_indication Builder — Phase 1.6c per architect spec.
 *
 * Converts already-stamped compounds-enriched.jsonl `compound.known_drug_info.indications[]`
 * rows into raw SAL assertion records. Both subject (compound.sid_s, Phase 1.1c) and
 * object (disease.sid_s, Phase 1.6b) are loaded from already-stamped JSONL files.
 *
 * Architectural simplification vs PR 1.6a bioactivity builder: NO predicate state
 * machine. clinical_indication uses deterministic constant `treats` — Layer 1 does
 * NOT interpret clinical_stage subjectivity per §19 Semantic Weight Isolation
 * (efficacy/stage gradient is Layer 3 SAL governance, NOT Layer 1 identity).
 *
 * Disease lookup reuses parseDiseaseIdNamespace from src/lib/schemas/disease.js
 * (the same parser PR-SID-1.6b-pre.1b linker uses) — guarantees byte-identical
 * Sciweon disease id derivation across linker + SAL builder. The disease.sid_s map
 * is keyed by raw_disease_id (e.g. 'EFO_0000764') as written by disease-linker.
 *
 * 5-bucket skip telemetry per Plan A1 + Defect-16 pattern (NOT silent drop):
 *   missing_compound_chembl_id     compound has no top-level chembl_id (no OT enrichment)
 *   missing_compound_sid           compound has chembl_id but no sid_s (Phase 1.1c skip)
 *   missing_indication_disease_id  indication entry has no disease_id field
 *   unparseable_disease_id         disease_id fails parseDiseaseIdNamespace
 *   missing_disease_sid            disease_id parses but Sciweon id not in disease crosswalk
 *                                  (OT indication references disease NOT in OT disease table)
 *
 * Production-measured scope (R2 probe 2026-05-25): 74,976 compounds, 2,337 carry
 * indications, 16,092 total indication rows → ~16,092 raw assertions emitted.
 */

import { createReadStream } from 'fs';
import readline from 'readline';
import { parseDiseaseIdNamespace } from '../../../src/lib/schemas/disease.js';

export const BUILDER_LABEL = 'SAL-OT-INDICATION-BUILDER';
export const ASSERTION_CLASS = 'clinical_indication';
export const PREDICATE_TREATS = 'treats';

async function loadJsonl(filePath) {
    const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });
    const records = [];
    let parseErrors = 0;
    for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { parseErrors++; }
    }
    return { records, parseErrors };
}

function buildCompoundSidMap(compounds) {
    const map = new Map();
    for (const c of compounds) {
        if (!c || typeof c.chembl_id !== 'string' || typeof c.sid_s !== 'string') continue;
        map.set(c.chembl_id, c.sid_s);
    }
    return map;
}

function buildCompoundLabelMap(compounds) {
    const map = new Map();
    for (const c of compounds) {
        if (!c || typeof c.chembl_id !== 'string') continue;
        const lbl = c.known_drug_info?.name || c.iupac_name || c.id;
        if (typeof lbl === 'string' && lbl.length > 0) map.set(c.chembl_id, lbl);
    }
    return map;
}

function buildDiseaseSidMap(diseases) {
    const map = new Map();
    for (const d of diseases) {
        if (!d || typeof d.raw_disease_id !== 'string' || typeof d.sid_s !== 'string') continue;
        map.set(d.raw_disease_id, d.sid_s);
    }
    return map;
}

function buildDiseaseLabelMap(diseases) {
    const map = new Map();
    for (const d of diseases) {
        if (!d || typeof d.raw_disease_id !== 'string') continue;
        const lbl = d.name || d.id;
        if (typeof lbl === 'string' && lbl.length > 0) map.set(d.raw_disease_id, lbl);
    }
    return map;
}

/**
 * Pure-function join helper: compound + one indication entry -> raw SAL assertion.
 * Returns { assertion } on success or { skip: <reason_key> } on filterable input.
 * Each skip path counted by buildOtIndicationAssertions for Plan-A1 telemetry.
 */
export function joinIndicationToAssertion(compound, indication, compoundSidMap, diseaseSidMap, compoundLabelMap, diseaseLabelMap) {
    const chemblId = compound?.chembl_id;
    if (typeof chemblId !== 'string' || chemblId.length === 0) return { skip: 'missing_compound_chembl_id' };
    const subjectSid = compoundSidMap.get(chemblId);
    if (!subjectSid) return { skip: 'missing_compound_sid' };

    const rawDiseaseId = indication?.disease_id;
    if (typeof rawDiseaseId !== 'string' || rawDiseaseId.length === 0) return { skip: 'missing_indication_disease_id' };
    const parsed = parseDiseaseIdNamespace(rawDiseaseId);
    if (!parsed) return { skip: 'unparseable_disease_id' };
    const objectSid = diseaseSidMap.get(rawDiseaseId);
    if (!objectSid) return { skip: 'missing_disease_sid' };

    return {
        assertion: {
            assertion_class: ASSERTION_CLASS,
            subject_canonical_sid: subjectSid,
            predicate: PREDICATE_TREATS,
            object_canonical_sid: objectSid,
            primary_source: `opentargets_indication:${chemblId}_${rawDiseaseId}`,
            source_record_id: `${compound.id}::${parsed.sciweon_id}`,
            display_context: {
                subject_label: compoundLabelMap?.get(chemblId),
                object_label: diseaseLabelMap?.get(rawDiseaseId),
            },
        },
    };
}

export async function buildOtIndicationAssertions({
    compoundsPath = 'output/linked/compounds-enriched.jsonl',
    diseasesPath = 'output/linked/diseases.jsonl',
} = {}) {
    const { records: compounds, parseErrors: cmpErrors } = await loadJsonl(compoundsPath);
    if (cmpErrors > 0) throw new Error(`[${BUILDER_LABEL}] compound parse errors: ${cmpErrors}`);
    const { records: diseases, parseErrors: disErrors } = await loadJsonl(diseasesPath);
    if (disErrors > 0) throw new Error(`[${BUILDER_LABEL}] disease parse errors: ${disErrors}`);

    const compoundSidMap = buildCompoundSidMap(compounds);
    const compoundLabelMap = buildCompoundLabelMap(compounds);
    const diseaseSidMap = buildDiseaseSidMap(diseases);
    const diseaseLabelMap = buildDiseaseLabelMap(diseases);

    console.log(`[${BUILDER_LABEL}] Loaded ${compounds.length} compounds (sidMap=${compoundSidMap.size}), ${diseases.length} diseases (sidMap=${diseaseSidMap.size})`);

    const rawAssertions = [];
    const skipCounts = {
        missing_compound_chembl_id: 0,
        missing_compound_sid: 0,
        missing_indication_disease_id: 0,
        unparseable_disease_id: 0,
        missing_disease_sid: 0,
    };
    let compoundsWithIndications = 0;
    let totalIndicationRows = 0;
    for (const compound of compounds) {
        const indications = compound?.known_drug_info?.indications;
        if (!Array.isArray(indications) || indications.length === 0) continue;
        compoundsWithIndications++;
        for (const ind of indications) {
            totalIndicationRows++;
            const r = joinIndicationToAssertion(compound, ind, compoundSidMap, diseaseSidMap, compoundLabelMap, diseaseLabelMap);
            if (r.skip) { skipCounts[r.skip]++; continue; }
            rawAssertions.push(r.assertion);
        }
    }
    console.log(`[${BUILDER_LABEL}] Emitted ${rawAssertions.length} raw assertions (compounds_with_indications=${compoundsWithIndications}, total_indication_rows=${totalIndicationRows}) | skips: ${JSON.stringify(skipCounts)}`);
    return {
        rawAssertions,
        stats: {
            totalCompounds: compounds.length,
            compoundsWithIndications,
            totalIndicationRows,
            emitted: rawAssertions.length,
            ...skipCounts,
        },
    };
}
