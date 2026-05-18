/**
 * NCI Thesaurus Adapter V2 — National Cancer Institute Thesaurus (NCIt).
 *
 * EVS REST API: https://evsrestapi.nci.nih.gov/evsrestapi/api/v1
 * Concepts tagged as "Drug or Chemical" or "Pharmacologic Substance"
 * provide cancer-domain drug names, synonyms, and relationships
 * that complement PubChem/ChEMBL coverage for oncology compounds.
 *
 * sinceToken: YYYY-MM-DD of last fetch. null = never fetched.
 * Re-fetches if sinceToken is older than fallbackFullRefreshDays (14).
 * Daily EVS updates are incremental; we use concept date filter if available.
 *
 * Scope: top-level "Pharmacologic Substance" subtree (C1254).
 * Returns normalized NCIt concepts with preferred name + synonyms.
 */

const EVS_BASE = 'https://evsrestapi.nci.nih.gov/evsrestapi/api/v1';
const TERMINOLOGY = 'ncit';
const ROOT_CODE = 'C1254'; // Pharmacologic Substance
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 30000;
const DELAY_MS = 500;

export const supportsIncremental     = true;
export const fallbackFullRefreshDays = 14;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function daysSince(dateStr) {
    if (!dateStr) return Infinity;
    return (Date.now() - new Date(dateStr).getTime()) / 86400000;
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

export function normalize(raw) {
    if (!raw?.code) return null;
    const ts = new Date().toISOString();
    const synonyms = (raw.synonyms ?? [])
        .filter(s => s.termType === 'SY' || s.termType === 'AB' || s.termType === 'PT')
        .map(s => s.name)
        .filter(Boolean)
        .slice(0, 50);
    return {
        id: `sciweon::nci_concept::${raw.code}`,
        code: raw.code,
        name: raw.name ?? null,
        synonyms,
        definition: raw.definitions?.[0]?.definition?.slice(0, 1000) ?? null,
        terminology: TERMINOLOGY,
        provenance: {
            sources: [{
                source: 'nci_thesaurus',
                source_id: raw.code,
                timestamp: ts,
                extraction_method: 'evs_rest_api_v1',
            }],
            last_updated: ts,
        },
        confidence: { overall: 85, method: 'single_source_authoritative' },
    };
}

export async function checkForUpdates(sinceToken) {
    const today = todayIso();
    const hasUpdates = daysSince(sinceToken) >= fallbackFullRefreshDays;
    try {
        const url = `${EVS_BASE}/concept/${TERMINOLOGY}/${ROOT_CODE}/subtree/roots`;
        await fetchJson(url);
        return { hasUpdates, count: null, nextSinceToken: today };
    } catch (e) {
        console.warn(`[NCI-THESAURUS] checkForUpdates: ${e.message}`);
        return { hasUpdates: false, count: null, nextSinceToken: sinceToken };
    }
}

export async function fetchIncremental(_sinceToken) {
    const nextSinceToken = todayIso();
    const records = [];
    let fromRecord = 0;

    console.log('[NCI-THESAURUS] Fetching Pharmacologic Substance subtree');

    while (true) {
        let data;
        try {
            const url = `${EVS_BASE}/concept/${TERMINOLOGY}?subset=${ROOT_CODE}`
                + `&include=synonyms,definitions&fromRecord=${fromRecord}&pageSize=${PAGE_SIZE}`;
            data = await fetchJson(url);
        } catch (e) {
            console.warn(`[NCI-THESAURUS] page fromRecord=${fromRecord}: ${e.message}`);
            break;
        }

        const items = Array.isArray(data) ? data : (data.concepts ?? []);
        if (items.length === 0) break;

        for (const raw of items) {
            const rec = normalize(raw);
            if (rec) records.push(rec);
        }

        fromRecord += items.length;
        if (items.length < PAGE_SIZE) break;
        await sleep(DELAY_MS);
    }

    console.log(`[NCI-THESAURUS] Done: ${records.length} concepts fetched`);
    return { records, nextSinceToken };
}
