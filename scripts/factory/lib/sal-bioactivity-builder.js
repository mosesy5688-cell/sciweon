/**
 * SAL Bioactivity-as-Assertion Builder — Phase 1.6a per architect spec.
 *
 * Converts already-stamped bioactivities.jsonl rows into raw SAL assertion records.
 * Both subject (compound.sid_s, Phase 1.1c) and object (target.sid_s, Phase 1.4)
 * are loaded from already-stamped JSONL files; the builder joins by record id.
 *
 * Per architect hard-fail spec: records whose compound_id or target_id cannot
 * resolve to a Layer 1 SID-S emit null subject/object_canonical_sid; downstream
 * classifier routes them to unstampable; orchestrator HALTS before R2 mutation.
 *
 * Predicate derivation (architect-locked):
 *   is_active === true AND activity_type ∈ INHIBITION_ROUTING_TYPES → 'inhibits'
 *   else                                                            → 'binds'
 *
 * Primary source: chembl_activity:<activity_id> (activity_id from
 * provenance.sources[] where source==='chembl' AND source_id matches /^\d+$/),
 * identical extraction rule as Phase 1.5 sid-bioactivity-stamping.js.
 */

import { createReadStream } from 'fs';
import readline from 'readline';

export const BUILDER_LABEL = 'SAL-BIOACTIVITY-BUILDER';
export const ASSERTION_CLASS = 'bioactivity_association';
export const PREDICATE_BINDS = 'binds';
export const PREDICATE_INHIBITS = 'inhibits';

// Activity types whose positive measurement implies an inhibition assertion.
const INHIBITION_ROUTING_TYPES = new Set([
    'IC50', 'Ki', 'EC50', 'Kd', 'AC50', 'IC90', 'GI50', 'inhibition',
]);

const CHEMBL_ACTIVITY_ID_PATTERN = /^\d+$/;

export function derivePredicate(bioactivity) {
    if (bioactivity?.is_active === true) {
        const at = bioactivity.activity_type;
        if (typeof at === 'string' && INHIBITION_ROUTING_TYPES.has(at)) return PREDICATE_INHIBITS;
    }
    return PREDICATE_BINDS;
}

export function deriveChemblActivityId(bioactivity) {
    if (!bioactivity || !bioactivity.provenance || !Array.isArray(bioactivity.provenance.sources)) return null;
    for (const src of bioactivity.provenance.sources) {
        if (!src || src.source !== 'chembl') continue;
        const id = src.source_id;
        if (typeof id !== 'string' || !CHEMBL_ACTIVITY_ID_PATTERN.test(id)) continue;
        return id;
    }
    return null;
}

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

function buildSidSMap(records, keyField, label) {
    const map = new Map();
    for (const rec of records) {
        if (!rec || typeof rec[keyField] !== 'string' || typeof rec.sid_s !== 'string' || rec.sid_s.length === 0) continue;
        map.set(rec[keyField], rec.sid_s);
    }
    if (map.size === 0) {
        console.warn(`[${BUILDER_LABEL}] WARN ${label} sid_s map empty (${records.length} records, key=${keyField}) — upstream stamper may not have run`);
    }
    return map;
}

function buildLabelMap(records, keyField, labelExtractor) {
    const map = new Map();
    for (const rec of records) {
        if (!rec || typeof rec[keyField] !== 'string') continue;
        const lbl = labelExtractor(rec);
        if (typeof lbl === 'string' && lbl.length > 0) map.set(rec[keyField], lbl);
    }
    return map;
}

export async function buildBioactivityAssertions({
    bioactivitiesPath = 'output/linked/bioactivities.jsonl',
    compoundsPath = 'output/linked/compounds-enriched.jsonl',
    targetsPath = 'output/linked/targets.jsonl',
} = {}) {
    const { records: bioactivities, parseErrors: bioErrors } = await loadJsonl(bioactivitiesPath);
    if (bioErrors > 0) throw new Error(`[${BUILDER_LABEL}] bioactivity parse errors: ${bioErrors}`);
    const { records: compounds, parseErrors: cmpErrors } = await loadJsonl(compoundsPath);
    if (cmpErrors > 0) throw new Error(`[${BUILDER_LABEL}] compound parse errors: ${cmpErrors}`);
    const { records: targets, parseErrors: tgtErrors } = await loadJsonl(targetsPath);
    if (tgtErrors > 0) throw new Error(`[${BUILDER_LABEL}] target parse errors: ${tgtErrors}`);

    const compoundSidSMap = buildSidSMap(compounds, 'id', 'compound');
    const targetSidSMap = buildSidSMap(targets, 'id', 'target');
    const compoundLabelMap = buildLabelMap(compounds, 'id', c => c.name || c.iupac_name || c.id);
    const targetLabelMap = buildLabelMap(targets, 'id', t => t.approved_symbol || t.gene_symbol || t.chembl_pref_name || t.id);

    console.log(`[${BUILDER_LABEL}] Loaded ${bioactivities.length} bioactivities, compoundMap=${compoundSidSMap.size}, targetMap=${targetSidSMap.size}`);

    const rawAssertions = [];
    const skipCounts = {
        missing_chembl_activity: 0,
        missing_target_resolution: 0,
        unstampable_orphan_target: 0,
        unstampable_orphan_compound: 0,
    };
    for (const b of bioactivities) {
        const joined = joinBioactivityToAssertion(b, compoundSidSMap, targetSidSMap, compoundLabelMap, targetLabelMap);
        if (joined.skip) {
            skipCounts[joined.skip]++;
            continue;
        }
        rawAssertions.push(joined.assertion);
    }
    console.log(`[${BUILDER_LABEL}] Emitted ${rawAssertions.length} raw assertions | skips: ${JSON.stringify(skipCounts)}`);
    return {
        rawAssertions,
        stats: {
            totalBioactivities: bioactivities.length,
            emitted: rawAssertions.length,
            missingChemblActivity: skipCounts.missing_chembl_activity,
            missingTargetResolution: skipCounts.missing_target_resolution,
            unstampableOrphanTarget: skipCounts.unstampable_orphan_target,
            unstampableOrphanCompound: skipCounts.unstampable_orphan_compound,
        },
    };
}

/**
 * Defect-16 fix: pure-function join helper for bioactivity → SAL assertion.
 *
 * Returns `{ assertion }` on success, or `{ skip: <reason_key> }` on filterable
 * upstream incompleteness. Filter reasons (per architect Plan A 2026-05-25):
 *
 *   - missing_chembl_activity:  bioactivity has no chembl provenance source_id
 *   - missing_target_resolution: bioactivity has no target.uniprot_accession
 *     (target-resolver did not produce a UniProt mapping for the ChEMBL target;
 *     bioactivity is structurally not SAL-eligible because its object has no
 *     Layer 1 SID-S)
 *   - unstampable_orphan_target: uniprot_accession present but the constructed
 *     `sciweon::target::uniprot:<acc>` key misses targetSidSMap — indicates
 *     target-linker / Phase 1.4 target stamper crosswalk drift
 *   - unstampable_orphan_compound: compound.id key misses compoundSidSMap —
 *     indicates compound-linker / Phase 1.1c compound stamper crosswalk drift
 *
 * Skips are EXPLICITLY counted and reported by orchestrator summary; this is
 * NOT silent drop per [[cross_cycle_silent_data_loss]] — it precisely defines
 * the system boundary: a SAL assertion requires both endpoints already SID-
 * stamped at Layer 1, per content-addressed deterministic anchor invariant.
 */
export function joinBioactivityToAssertion(b, compoundSidSMap, targetSidSMap, compoundLabelMap, targetLabelMap) {
    const activityId = deriveChemblActivityId(b);
    if (!activityId) return { skip: 'missing_chembl_activity' };

    const uniprotAccession = b?.target?.uniprot_accession;
    if (typeof uniprotAccession !== 'string' || uniprotAccession.length === 0) {
        return { skip: 'missing_target_resolution' };
    }

    const targetLookupKey = `sciweon::target::uniprot:${uniprotAccession}`;
    const objectSid = targetSidSMap.get(targetLookupKey);
    if (!objectSid) return { skip: 'unstampable_orphan_target' };

    const subjectSid = compoundSidSMap.get(b.compound_id);
    if (!subjectSid) return { skip: 'unstampable_orphan_compound' };

    return {
        assertion: {
            assertion_class: ASSERTION_CLASS,
            subject_canonical_sid: subjectSid,
            predicate: derivePredicate(b),
            object_canonical_sid: objectSid,
            primary_source: `chembl_activity:${activityId}`,
            source_record_id: b.id,
            display_context: {
                subject_label: compoundLabelMap?.get(b.compound_id),
                object_label: targetLabelMap?.get(targetLookupKey),
            },
        },
    };
}
