/**
 * openFDA Adapter — Sciweon V0.3.4
 *
 * US FDA authoritative drug regulatory data. Three endpoints used here:
 *   - /drug/label.json       (FDA-approved drug labels with boxed warnings)
 *   - /drug/enforcement.json (drug recalls + classification)
 *   - /drug/drugsfda.json    (FDA-approved applications)
 *
 * UNII-keyed lookup (we already have UNII from V0.3.2 UniChem). This unlocks
 * V0.4 Negative Evidence categories D (black box warning + drug withdrawal)
 * and E (AERS — separate adapter, deferred to V0.4 for full FAERS scale).
 *
 * API docs: https://open.fda.gov/apis/drug/
 * Base: https://api.fda.gov
 *
 * PRIMARY-DATA contract (primary-data-only policy):
 *   Consumed (FDA-curated authoritative regulatory data):
 *     - brand_name / generic_name / manufacturer_name
 *     - application_number      (FDA-issued canonical ID)
 *     - product_ndc / route / product_type
 *     - boxed_warning           (FDA-mandated black box text — primary fact)
 *     - warnings_and_cautions / contraindications / adverse_reactions
 *       (FDA-required label sections, raw text)
 *     - openfda.unii / rxcui    (cross-ref to canonical IDs)
 *     - openfda.pharm_class_epc (FDA Established Pharmacologic Class —
 *       FDA authoritative international standard, parallel to WHO ATC codes)
 *     - recall.classification   (Class I/II/III, FDA-mandated severity)
 *     - recall.reason_for_recall (FDA-curated reason text)
 *
 *   pharm_class_cs/moa/pe also acceptable as FDA authoritative classification
 *   (parallel to ATC codes — international standard via FDA authority).
 *
 *   NOT consumed:
 *     - patient_information   (lay-language derivative of warnings)
 *     - spl_metadata          (PDF rendering metadata, not data)
 */

import { fetchOpenFda, redactApiKey, OPENFDA_REQUEST_DELAY_MS } from '../../factory/lib/openfda-auth.js';
import { fetchAllPages, MAX_PAGES_PER_UNII } from '../../factory/lib/openfda-paginate.js';

// V2 adapter contract: reactive UNII-keyed lookup — FDA openFDA has no stable incremental cursor.
export const supportsIncremental = false;

const OPENFDA_BASE = 'https://api.fda.gov';

// Pacing now lives in the shared TokenBucket (openfda-auth.js). REQUEST_DELAY_MS
// is re-exported from there (~294ms = under the keyed 240/min wall) so existing
// importers (fda-enricher / compound-faers-enricher) keep working unchanged.
const REQUEST_DELAY_MS = OPENFDA_REQUEST_DELAY_MS;

// SENTINEL CONTRACT (part 3): a 404 / 200-with-results:[] is a GENUINE EMPTY ->
// return [] (the load-bearing common case for real drugs; the enricher stamps it
// COMPLETE). A 429 / 5xx / timeout / network / parse error is a FETCH FAILURE ->
// fetchOpenFda throws OpenFdaFetchError -> these helpers return null (a DISTINCT
// sentinel) so the enricher does NOT stamp genuine-empty and the record stays
// eligible + the error is counted loudly. All warn lines are pre-redacted.

/**
 * Fetch ALL drug labels by FDA UNII, paginated to completion (R3). Multiple
 * labels exist per substance (formulations / manufacturers); the probe measured
 * up to 2499 -> ~3 pages. Every page flows through the ONE shared TokenBucket
 * (fetchOpenFda). ANY page failure -> null (never stamp a partial as complete).
 * @returns {Promise<{results:Array, truncated:boolean}|null>} object (results
 *   possibly empty) on success/genuine-empty; null on fetch failure.
 */
export async function fetchLabelsByUnii(unii, pageLimit = 1000) {
    if (!unii) return { results: [], truncated: false };
    const build = (skip, lim) =>
        `${OPENFDA_BASE}/drug/label.json?search=openfda.unii:${encodeURIComponent(unii)}&limit=${lim}&skip=${skip}`;
    try {
        return await fetchAllPages(fetchOpenFda, build, { pageLimit });
    } catch (e) {
        console.warn(`[OPENFDA] label ${unii}: ${redactApiKey(e.message)}`);
        return null;                       // FETCH FAILURE sentinel
    }
}

/**
 * Fetch FAERS adverse-event signal aggregation by UNII.
 *
 * V0.4.1: Agent needs quantified safety signals ("compound X has 1000
 * hepatotoxicity reports"), not 24M individual records. openFDA count
 * aggregation returns top ADR terms with FAERS report counts in a single
 * API call — Sciweon stores signal-level signal, not raw reports.
 *
 * MedDRA Preferred Terms (PT) are ICH international standard medical
 * vocabulary — primary, authoritative-source exempt (like MeSH).
 *
 * @returns {Promise<{terms:Array<{term,count}>, truncated:boolean}|null>}
 *   object (terms possibly empty) on success/genuine-empty; null on fetch
 *   failure. `truncated` (part 5) = results.length >= the requested limit, i.e.
 *   the count is a TOP-N SLICE, not the full distinct-term set.
 */
export async function fetchFaersSignalsByUnii(unii, limit = 1000) {
    if (!unii) return { terms: [], truncated: false };
    const url = `${OPENFDA_BASE}/drug/event.json?search=patient.drug.openfda.unii:${encodeURIComponent(unii)}&count=patient.reaction.reactionmeddrapt.exact&limit=${limit}`;
    try {
        const data = await fetchOpenFda(url);
        const results = data?.results ?? [];   // null (404) -> [] genuine-empty
        return {
            terms: results.map(r => ({ term: r.term, count: r.count ?? 0 })),
            truncated: results.length >= limit,
        };
    } catch (e) {
        console.warn(`[OPENFDA] FAERS ${unii}: ${redactApiKey(e.message)}`);
        return null;                            // FETCH FAILURE sentinel
    }
}

/**
 * Fetch ALL recall events by UNII, paginated to completion (R3). The probe
 * measured up to 13 recalls (1 page); the full set is REQUIRED so
 * most_severe_recall_class + recall_count are computed over EVERY recall (the
 * old limit-10 falsely-cleaned a Class-I at rank 11). ANY page failure -> null.
 * @returns {Promise<{results:Array, truncated:boolean}|null>} object on
 *   success/genuine-empty; null on fetch failure.
 */
export async function fetchRecallsByUnii(unii, pageLimit = 1000) {
    if (!unii) return { results: [], truncated: false };
    const build = (skip, lim) =>
        `${OPENFDA_BASE}/drug/enforcement.json?search=openfda.unii:${encodeURIComponent(unii)}&limit=${lim}&skip=${skip}`;
    try {
        return await fetchAllPages(fetchOpenFda, build, { pageLimit });
    } catch (e) {
        console.warn(`[OPENFDA] recall ${unii}: ${redactApiKey(e.message)}`);
        return null;                       // FETCH FAILURE sentinel
    }
}

/**
 * Extract PRIMARY-only signals from a UNII's worth of FDA data (preserve-all,
 * NO slices -- the schema runaway guards bound the size, fail-soft on overflow).
 * Aggregates across ALL labels (one substance has many label records). R5:
 * collects EVERY boxed warning into boxed_warnings[] (no 1-of-N drop) while
 * keeping boxed_warning_text = the FIRST (back-compat). R3: recomputes
 * most_severe_recall_class over the FULL paginated recall set + carries the
 * label_truncated / recall_truncated flags.
 * @param {object} [flags] { labelTruncated, recallTruncated } from R3 pagination
 */
export function aggregateSignals(labels, recalls, flags = {}) {
    const labelsArr = labels ?? [];
    const recallsArr = recalls ?? [];
    if (labelsArr.length === 0 && recallsArr.length === 0) return null;

    const boxedWarnings = [];   // R5: ALL warnings, full text, no slice.
    const pharmClassEpc = new Set();
    const pharmClassMoa = new Set();
    const applicationNumbers = new Set();
    let hasIndications = false;
    let hasContraindications = false;

    for (const lbl of labelsArr) {
        if (Array.isArray(lbl.boxed_warning)) {
            for (const w of lbl.boxed_warning) {
                if (typeof w === 'string' && w.length > 0) boxedWarnings.push({ text: w });
            }
        }
        if (lbl.indications_and_usage) hasIndications = true;
        if (lbl.contraindications) hasContraindications = true;
        const o = lbl.openfda ?? {};
        for (const c of (o.pharm_class_epc ?? [])) pharmClassEpc.add(c);
        for (const c of (o.pharm_class_moa ?? [])) pharmClassMoa.add(c);
        for (const a of (o.application_number ?? [])) applicationNumbers.add(a);
    }

    const recallClassRanking = { 'Class I': 3, 'Class II': 2, 'Class III': 1 };
    let mostSevere = null;
    let mostSevereRank = 0;
    for (const r of recallsArr) {
        const rank = recallClassRanking[r.classification] ?? 0;
        if (rank > mostSevereRank) { mostSevereRank = rank; mostSevere = r.classification; }
    }

    const firstWarning = boxedWarnings.length > 0 ? boxedWarnings[0].text : null;
    const out = {
        has_drug_label: labelsArr.length > 0,
        label_count: labelsArr.length,
        has_boxed_warning: boxedWarnings.length > 0,
        boxed_warning_text: firstWarning,
        boxed_warnings: boxedWarnings,
        has_indications: hasIndications,
        has_contraindications: hasContraindications,
        application_numbers: [...applicationNumbers],
        pharm_class_epc: [...pharmClassEpc],
        pharm_class_moa: [...pharmClassMoa],
        recall_count: recallsArr.length,
        most_severe_recall_class: mostSevere,
        sources: [
            ...(labelsArr.length > 0 ? ['openfda_drug_label'] : []),
            ...(recallsArr.length > 0 ? ['openfda_enforcement'] : []),
        ],
    };
    if (flags.labelTruncated) out.label_truncated = true;
    if (flags.recallTruncated) out.recall_truncated = true;
    return out;
}

export { REQUEST_DELAY_MS, MAX_PAGES_PER_UNII };
