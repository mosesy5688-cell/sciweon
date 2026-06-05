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
 * Fetch drug label(s) by FDA UNII. Multiple labels may exist for the same
 * substance (different formulations / manufacturers).
 * @returns {Promise<Array|null>} [] on genuine-empty/404, null on fetch failure.
 */
export async function fetchLabelsByUnii(unii, limit = 5) {
    if (!unii) return [];
    const url = `${OPENFDA_BASE}/drug/label.json?search=openfda.unii:${encodeURIComponent(unii)}&limit=${limit}`;
    try {
        const data = await fetchOpenFda(url);
        return data?.results ?? [];        // null (404) -> [] genuine-empty
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
export async function fetchFaersSignalsByUnii(unii, limit = 20) {
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
 * Fetch recall events by UNII.
 * @returns {Promise<Array|null>} [] on genuine-empty/404, null on fetch failure.
 */
export async function fetchRecallsByUnii(unii, limit = 10) {
    if (!unii) return [];
    const url = `${OPENFDA_BASE}/drug/enforcement.json?search=openfda.unii:${encodeURIComponent(unii)}&limit=${limit}`;
    try {
        const data = await fetchOpenFda(url);
        return data?.results ?? [];        // null (404) -> [] genuine-empty
    } catch (e) {
        console.warn(`[OPENFDA] recall ${unii}: ${redactApiKey(e.message)}`);
        return null;                       // FETCH FAILURE sentinel
    }
}

/**
 * Extract PRIMARY-only signals from a UNII's worth of FDA data.
 * Aggregates across multiple labels (one substance can have many label
 * records). Returns a flat fda_signals object suitable for compound.
 */
export function aggregateSignals(labels, recalls) {
    const labelsArr = labels ?? [];
    const recallsArr = recalls ?? [];
    if (labelsArr.length === 0 && recallsArr.length === 0) return null;

    let boxedWarning = null;
    const pharmClassEpc = new Set();
    const pharmClassMoa = new Set();
    const applicationNumbers = new Set();
    let hasIndications = false;
    let hasContraindications = false;

    for (const lbl of labelsArr) {
        if (!boxedWarning && Array.isArray(lbl.boxed_warning) && lbl.boxed_warning.length > 0) {
            boxedWarning = lbl.boxed_warning[0].slice(0, 4000);
        }
        if (lbl.indications_and_usage) hasIndications = true;
        if (lbl.contraindications) hasContraindications = true;
        const o = lbl.openfda ?? {};
        for (const c of (o.pharm_class_epc ?? [])) pharmClassEpc.add(c);
        for (const c of (o.pharm_class_moa ?? [])) pharmClassMoa.add(c);
        for (const a of (o.application_number ?? [])) applicationNumbers.add(a);
    }

    const recallClassifications = recallsArr.map(r => r.classification).filter(Boolean);
    const recallClassRanking = { 'Class I': 3, 'Class II': 2, 'Class III': 1 };
    let mostSevere = null;
    let mostSevereRank = 0;
    for (const c of recallClassifications) {
        const rank = recallClassRanking[c] ?? 0;
        if (rank > mostSevereRank) { mostSevereRank = rank; mostSevere = c; }
    }

    return {
        has_drug_label: labelsArr.length > 0,
        label_count: labelsArr.length,
        has_boxed_warning: boxedWarning !== null,
        boxed_warning_text: boxedWarning,
        has_indications: hasIndications,
        has_contraindications: hasContraindications,
        application_numbers: [...applicationNumbers].slice(0, 20),
        pharm_class_epc: [...pharmClassEpc].slice(0, 20),
        pharm_class_moa: [...pharmClassMoa].slice(0, 20),
        recall_count: recallsArr.length,
        most_severe_recall_class: mostSevere,
        sources: [
            ...(labelsArr.length > 0 ? ['openfda_drug_label'] : []),
            ...(recallsArr.length > 0 ? ['openfda_enforcement'] : []),
        ],
    };
}

export { REQUEST_DELAY_MS };
