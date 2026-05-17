/**
 * DailyMed Adapter V2 — Sciweon V0.5.4
 *
 * Incremental harvest of FDA/NLM DailyMed drug labels (SPL format).
 * Implements the Sciweon DataSourceAdapterV2 interface (§11.2):
 *   - checkForUpdates(sinceToken) → { hasUpdates, count, nextSinceToken }
 *   - fetchIncremental(sinceToken) → { records, nextSinceToken }
 *   - supportsIncremental = true
 *
 * Data source: DailyMed REST API v2 (NLM/FDA, public domain)
 *   - Base: https://dailymed.nlm.nih.gov/dailymed/services/v2
 *   - Archives: https://dailymed.nlm.nih.gov/dailymed/archives/{setid}.zip
 *
 * sinceToken format: YYYY-MM-DD ISO date (adapter-opaque per §11.2).
 *   null bootstrap → today - 7 days.
 *   Advances to today's date after fetchIncremental completes.
 *
 * What this adapter produces: DrugLabel entities (drug_label entity type).
 * Each entity contains prescribing info sections (indications, dosage,
 * contraindications, drug interactions, mechanism, PK, boxed warning).
 *
 * Phase A scope: HUMAN PRESCRIPTION DRUG labels only.
 * OTC labels defer to V0.5.5.
 *
 * Rate limiting: 350ms between requests. DailyMed is a US government
 * service; polite rate limiting ensures long-term access.
 *
 * Section content extraction: fetches SPL ZIP archive per label, extracts
 * XML via spl-parser.js (custom ZIP+DEFLATE decoder, no external deps).
 * If ZIP fetch/parse fails, metadata-only record is saved (sections = null).
 */

import { parseSplSections, extractXmlFromZip, LOINC_SECTIONS } from '../../factory/lib/spl-parser.js';
import { scoreDataPoint } from '../../factory/lib/confidence-scorer.js';

const DAILYMED_BASE    = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';
const DAILYMED_ARCHIVE = 'https://dailymed.nlm.nih.gov/dailymed/archives';
const LIST_PAGE_SIZE   = 100;
const REQUEST_TIMEOUT_MS  = 30000;
const ARCHIVE_TIMEOUT_MS  = 60000;
const DELAY_MS            = 350;

// v2 adapter interface metadata
export const supportsIncremental    = true;
export const fallbackFullRefreshDays = 90; // unused since supportsIncremental=true

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function bootstrapSince() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
}

/**
 * Normalize DailyMed published_date (MM/DD/YYYY or ISO) → YYYY-MM-DD.
 */
function normalizeDailyMedDate(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr).trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s;
}

/**
 * Accept HUMAN PRESCRIPTION and HUMAN OTC drug labels.
 * Skip animal drugs, cosmetics, dietary supplements, etc.
 */
function isAcceptedLabelType(labelType) {
    if (!labelType) return false;
    const lt = String(labelType).toUpperCase();
    return lt.includes('HUMAN PRESCRIPTION') || lt.includes('HUMAN OTC');
}

function buildNullSections() {
    const sections = {};
    for (const name of Object.values(LOINC_SECTIONS)) sections[name] = null;
    return sections;
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Sciweon/0.5 (+https://sciweon.com; scientific data infrastructure)',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

async function fetchBinary(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Sciweon/0.5 (+https://sciweon.com; scientific data infrastructure)',
        },
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * List SPL records updated since startDate (paginated).
 * @returns {{ total: number, items: Array<{setid: string, published_date: string, title: string}> }}
 */
async function listSplPage(startDate, page) {
    const params = new URLSearchParams({
        startdate: startDate,
        pagesize: String(LIST_PAGE_SIZE),
        page: String(page),
        labeltype: 'HUMAN PRESCRIPTION DRUG',
    });
    const url = `${DAILYMED_BASE}/spls.json?${params}`;
    const data = await fetchJson(url);
    return {
        total: data.metadata?.total ?? 0,
        items: Array.isArray(data.data) ? data.data : [],
    };
}

/**
 * Fetch full metadata for a specific setid.
 * Returns { setid, spl_version, published_date, title, label_type, dosage_forms,
 *           application_numbers, rxcui } or null on failure.
 */
async function fetchLabelMeta(setid) {
    const url = `${DAILYMED_BASE}/spls/${encodeURIComponent(setid)}.json`;
    const data = await fetchJson(url);
    return data.data ?? null;
}

/**
 * Fetch SPL ZIP archive and extract section text via spl-parser.
 * Returns parsed sections map or null if fetch/parse fails (metadata-only).
 */
async function fetchSections(setid) {
    try {
        const zipBuf = await fetchBinary(`${DAILYMED_ARCHIVE}/${encodeURIComponent(setid)}.zip`);
        const xml = await extractXmlFromZip(zipBuf);
        if (!xml) {
            console.warn(`[DAILYMED] ${setid}: ZIP contained no XML — metadata-only`);
            return null;
        }
        return parseSplSections(xml);
    } catch (e) {
        console.warn(`[DAILYMED] ${setid}: sections fetch failed: ${e.message} — metadata-only`);
        return null;
    }
}

/**
 * Normalize DailyMed metadata + parsed sections → DrugLabel entity.
 *
 * Entity ID: sciweon::drug_label::setid::{setid}
 * Entity type: drug_label (new first-class entity, not a compound attribute)
 *
 * NegEvidence bridge: has_boxed_warning=true flags this label for NegEvidence
 * pipeline enrichment (augments existing openFDA black_box_warning signals).
 */
export function normalize(meta, sections) {
    if (!meta?.setid) return null;

    const timestamp = new Date().toISOString();
    const rxcuiRaw = meta.rxcui;
    const rxcui = Array.isArray(rxcuiRaw)
        ? rxcuiRaw.map(String).filter(Boolean)
        : rxcuiRaw ? [String(rxcuiRaw)] : [];

    const resolvedSections = sections ?? buildNullSections();

    return {
        id: `sciweon::drug_label::setid::${meta.setid}`,
        setid: meta.setid,
        spl_version: meta.spl_version != null ? String(meta.spl_version) : null,
        title: (meta.title ?? '').slice(0, 500),
        label_type: meta.label_type ?? null,
        rxcui,
        application_numbers: Array.isArray(meta.application_numbers)
            ? meta.application_numbers.map(String).filter(Boolean)
            : [],
        dosage_forms: Array.isArray(meta.dosage_forms)
            ? meta.dosage_forms.map(String).filter(Boolean).slice(0, 20)
            : [],
        sections: resolvedSections,
        has_boxed_warning: resolvedSections.boxed_warning != null,
        sections_extracted: sections !== null,
        published_date: normalizeDailyMedDate(meta.published_date),
        provenance: {
            sources: [{
                source: 'dailymed',
                source_id: meta.setid,
                timestamp,
                extraction_method: 'dailymed_rest_v2',
            }],
            last_updated: timestamp,
        },
        confidence: {
            overall: scoreDataPoint(['dailymed']),
            method: 'cross_source_consensus_v2',
            cross_source_agreement: { structural_match: false, conflicts: [] },
        },
    };
}

/**
 * checkForUpdates — fast probe, no data fetched.
 *
 * Queries DailyMed list endpoint with pagesize=1 to get total count of labels
 * updated since sinceToken date. Does NOT advance sinceToken (caller preserves
 * current token; only fetchIncremental advances it).
 *
 * @param {string|null} sinceToken - YYYY-MM-DD or null (bootstrap)
 * @returns {Promise<{hasUpdates: boolean, count: number, nextSinceToken: string|null}>}
 */
export async function checkForUpdates(sinceToken) {
    const startDate = sinceToken ?? bootstrapSince();
    try {
        const params = new URLSearchParams({
            startdate: startDate,
            pagesize: '1',
            page: '1',
            labeltype: 'HUMAN PRESCRIPTION DRUG',
        });
        const data = await fetchJson(`${DAILYMED_BASE}/spls.json?${params}`);
        const total = data.metadata?.total ?? 0;
        return { hasUpdates: total > 0, count: total, nextSinceToken: sinceToken };
    } catch (e) {
        console.warn(`[DAILYMED] checkForUpdates: ${e.message}`);
        return { hasUpdates: false, count: 0, nextSinceToken: sinceToken };
    }
}

/**
 * fetchIncremental — paginate DailyMed list, fetch metadata + sections per label.
 *
 * For each updated label:
 *   1. GET /spls/{setid}.json → metadata
 *   2. Skip non-ACCEPTED label types (animal drugs, cosmetics, etc.)
 *   3. GET /archives/{setid}.zip → extract XML → parse sections (best-effort)
 *   4. normalize(meta, sections) → DrugLabel entity
 *
 * Rate: 350ms delay between every API call. At ~2 calls/label + 1/page-list,
 * fetching 100 labels takes ~70s (safe for GHA 60-min timeout).
 *
 * Cursor advance: nextSinceToken = today's date (ISO). Cursor is written to R2
 * by the caller (dailymed-harvest.js) ONLY after output is successfully written.
 *
 * @param {string|null} sinceToken - YYYY-MM-DD or null (bootstrap)
 * @param {number} [limit=Infinity] - Max labels to return (CLI override)
 * @returns {Promise<{records: Array, nextSinceToken: string}>}
 */
export async function fetchIncremental(sinceToken, limit = Infinity) {
    const startDate = sinceToken ?? bootstrapSince();
    const records = [];
    let page = 1;
    let total = null;
    let fetched = 0;
    let skipped = 0;

    console.log(`[DAILYMED] fetchIncremental since=${startDate}${limit < Infinity ? ` limit=${limit}` : ''}`);

    while (fetched < limit) {
        const { total: pageTotal, items } = await listSplPage(startDate, page);
        await sleep(DELAY_MS);

        if (total === null) {
            total = pageTotal;
            console.log(`[DAILYMED] ${total} prescription labels updated since ${startDate}`);
        }

        if (items.length === 0) break;

        for (const item of items) {
            if (fetched >= limit) break;
            const setid = item.setid;
            if (!setid) { skipped++; continue; }

            try {
                const meta = await fetchLabelMeta(setid);
                await sleep(DELAY_MS);

                if (!meta) { skipped++; continue; }
                if (!isAcceptedLabelType(meta.label_type)) { skipped++; continue; }

                const sections = await fetchSections(setid);
                await sleep(DELAY_MS);

                const entity = normalize(meta, sections);
                if (!entity) { skipped++; continue; }

                records.push(entity);
                fetched++;

                if (fetched % 50 === 0) {
                    console.log(`[DAILYMED] progress: ${fetched} fetched, ${skipped} skipped`);
                }
            } catch (e) {
                console.warn(`[DAILYMED] setid ${setid} failed: ${e.message} — skipping`);
                skipped++;
            }
        }

        // Break if we've paged through all results
        const maxPage = Math.ceil((total ?? 0) / LIST_PAGE_SIZE);
        if (page >= maxPage) break;
        page++;
    }

    console.log(`[DAILYMED] Done: ${records.length} labels fetched, ${skipped} skipped`);
    return { records, nextSinceToken: todayIso() };
}
