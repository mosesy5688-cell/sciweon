/**
 * RxNorm (NLM RxNav) Adapter — Sciweon V0.3.3
 *
 * NLM's standardized US drug nomenclature. RXCUI is the canonical
 * identifier for medications used by US healthcare IT systems (EHRs,
 * pharmacies, FDA NDC mapping). Lookup by FDA UNII (already obtained
 * from UniChem in V0.3.2) for clean structural anchoring.
 *
 * API docs: https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html
 * Base: https://rxnav.nlm.nih.gov/REST
 *
 * PRIMARY-DATA contract:
 *   Consumed (NIH/NLM authoritative US drug identifier):
 *     - RXCUI  (RxNorm Concept Unique Identifier)
 *     - properties.name  (RxNorm-canonical drug name; NLM authoritative)
 *     - properties.tty   (Term Type — NLM controlled vocabulary like IN,
 *                         BN, SCD, GPCK — same authority class as MeSH)
 *
 *   NOT consumed:
 *     - properties.synonym (often empty; not a primary identifier)
 *     - related concepts / classes  (derivative groupings — V0.4 if needed)
 */

const RXNAV_BASE = 'https://rxnav.nlm.nih.gov/REST';
// V2 adapter contract: reactive UNII/RXCUI lookup only — no source-side incremental API.
export const supportsIncremental = false;

const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_DELAY_MS = 150;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
        if (res.status === 404) return null;
        if (res.status === 429 || res.status === 503) {
            await sleep(3000);
            const retry = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!retry.ok) throw new Error(`HTTP ${retry.status}: ${url}`);
            return retry.json();
        }
        throw new Error(`HTTP ${res.status}: ${url}`);
    }
    return res.json();
}

/**
 * Map UNII -> RXCUI via RxNav identifier lookup.
 * Returns null if no RxNorm concept exists for the substance (common for
 * non-drug compounds, research-only molecules, etc.).
 */
export async function fetchRxcuiByUnii(unii) {
    if (!unii) return null;
    try {
        const data = await fetchJson(`${RXNAV_BASE}/rxcui.json?idtype=UNII_CODE&id=${encodeURIComponent(unii)}`);
        const rxcui = data?.idGroup?.rxnormId?.[0];
        return rxcui ? String(rxcui) : null;
    } catch (e) {
        console.warn(`[RXNORM] unii ${unii}: ${e.message}`);
        return null;
    }
}

/**
 * Fetch RxNorm concept properties: canonical name and term type.
 */
export async function fetchPropertiesByRxcui(rxcui) {
    if (!rxcui) return null;
    try {
        const data = await fetchJson(`${RXNAV_BASE}/rxcui/${encodeURIComponent(rxcui)}/properties.json`);
        const p = data?.properties;
        if (!p) return null;
        return {
            rxcui: p.rxcui ? String(p.rxcui) : rxcui,
            rxnorm_name: p.name || null,
            tty: p.tty || null,
        };
    } catch (e) {
        console.warn(`[RXNORM] properties ${rxcui}: ${e.message}`);
        return null;
    }
}

/**
 * Combined: UNII -> RXCUI -> properties. Returns null if no mapping.
 */
export async function resolveByUnii(unii) {
    const rxcui = await fetchRxcuiByUnii(unii);
    if (!rxcui) return null;
    await sleep(REQUEST_DELAY_MS);
    const props = await fetchPropertiesByRxcui(rxcui);
    return props ?? { rxcui, rxnorm_name: null, tty: null };
}

export { REQUEST_DELAY_MS };
