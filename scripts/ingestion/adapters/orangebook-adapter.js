/**
 * Orange Book Adapter V2 — FDA Approved Drug Products (Orange Book).
 *
 * The Orange Book lists FDA-approved drug products with patent/exclusivity
 * data — authoritative for IP landscape analysis in drug discovery.
 *
 * Data source: OpenFDA /drug/drugsfda.json endpoint, which exposes the
 * Orange Book NDA/ANDA submissions with application details.
 *
 * sinceToken: YYYY-MM-DD of last fetch. Cadence: 7 days (FDA updates weekly).
 * Incremental filter: application_date range via openFDA search syntax.
 *
 * Each record covers one NDA/ANDA application with active ingredients,
 * products (strengths/dosage forms), and patent/exclusivity codes.
 */

const OPENFDA_BASE = 'https://api.fda.gov/drug/drugsfda.json';
const PAGE_LIMIT = 100; // openFDA max per request
const REQUEST_TIMEOUT_MS = 20000;
const DELAY_MS = 300;

export const supportsIncremental     = true;
export const fallbackFullRefreshDays = 7;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function sinceDateDefault() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

export function normalize(raw) {
    if (!raw?.application_number) return null;
    const ts = new Date().toISOString();
    const products = (raw.products ?? []).map(p => ({
        brand_name: p.brand_name ?? null,
        active_ingredients: (p.active_ingredients ?? []).map(ai => ({
            name: ai.name ?? null,
            strength: ai.strength ?? null,
        })),
        dosage_form: p.dosage_form ?? null,
        route: p.route ?? null,
        marketing_status: p.marketing_status ?? null,
        te_code: p.te_code ?? null,
    }));
    return {
        id: `sciweon::orangebook::${raw.application_number}`,
        application_number: raw.application_number,
        application_type: raw.application_number?.startsWith('NDA') ? 'NDA'
            : raw.application_number?.startsWith('ANDA') ? 'ANDA'
            : raw.application_number?.startsWith('BLA') ? 'BLA' : 'OTHER',
        sponsor_name: raw.sponsor_name ?? null,
        products,
        openfda: {
            brand_name: raw.openfda?.brand_name ?? [],
            generic_name: raw.openfda?.generic_name ?? [],
            substance_name: raw.openfda?.substance_name ?? [],
        },
        submissions: (raw.submissions ?? []).slice(0, 10).map(s => ({
            submission_type: s.submission_type ?? null,
            submission_number: s.submission_number ?? null,
            submission_status: s.submission_status ?? null,
            submission_status_date: s.submission_status_date ?? null,
        })),
        provenance: {
            sources: [{
                source: 'fda_orangebook',
                source_id: raw.application_number,
                timestamp: ts,
                extraction_method: 'openfda_drugsfda_v1',
            }],
            last_updated: ts,
        },
        confidence: { overall: 90, method: 'single_source_authoritative' },
    };
}

export async function checkForUpdates(sinceToken) {
    const since = sinceToken ?? sinceDateDefault();
    const today = todayIso();
    try {
        const search = `submissions.submission_status_date:[${since.replace(/-/g, '')} TO ${today.replace(/-/g, '')}]`;
        const url = `${OPENFDA_BASE}?search=${encodeURIComponent(search)}&limit=1`;
        const data = await fetchJson(url);
        const count = data?.meta?.results?.total ?? 0;
        return { hasUpdates: count > 0, count, nextSinceToken: today };
    } catch (e) {
        console.warn(`[ORANGEBOOK] checkForUpdates: ${e.message}`);
        return { hasUpdates: false, count: 0, nextSinceToken: sinceToken };
    }
}

export async function fetchIncremental(sinceToken) {
    const since = sinceToken ?? sinceDateDefault();
    const today = todayIso();
    const nextSinceToken = today;
    const records = [];
    let skip = 0;

    console.log(`[ORANGEBOOK] fetchIncremental since=${since}`);
    const search = `submissions.submission_status_date:[${since.replace(/-/g, '')} TO ${today.replace(/-/g, '')}]`;

    while (true) {
        let data;
        try {
            const url = `${OPENFDA_BASE}?search=${encodeURIComponent(search)}&limit=${PAGE_LIMIT}&skip=${skip}`;
            data = await fetchJson(url);
        } catch (e) {
            console.warn(`[ORANGEBOOK] page skip=${skip}: ${e.message}`);
            break;
        }
        if (!data?.results?.length) break;
        for (const raw of data.results) {
            const rec = normalize(raw);
            if (rec) records.push(rec);
        }
        skip += data.results.length;
        const total = data.meta?.results?.total ?? 0;
        if (skip >= total || data.results.length < PAGE_LIMIT) break;
        await sleep(DELAY_MS);
    }

    console.log(`[ORANGEBOOK] Done: ${records.length} applications fetched`);
    return { records, nextSinceToken };
}
