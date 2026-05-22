/**
 * DailyMed HTTP + utility helpers — internal module for dailymed-adapter.js.
 * Not part of the DataSourceAdapterV2 public interface.
 */

import { parseSplSections, extractXmlFromZip, LOINC_SECTIONS } from '../../factory/lib/spl-parser.js';

export const DAILYMED_BASE    = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';
// Cycle 21 PR #7: archive ZIP path moved from /dailymed/archives/{setid}.zip
// (now 302 → /dailymed/index.cfm — HTML homepage, breaks every ZIP parse) to
// /dailymed/getFile.cfm?setid=…&type=zip&name=…. Verified live 2026-05-22.
// [[feedback_local_verify_external_api]]
export const DAILYMED_GETFILE = 'https://dailymed.nlm.nih.gov/dailymed/getFile.cfm';
export const LIST_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS  = 30000;
const ARCHIVE_TIMEOUT_MS  = 60000;
export const DELAY_MS     = 350;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

export function bootstrapSince() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
}

// MM/DD/YYYY or ISO → YYYY-MM-DD
export function normalizeDailyMedDate(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr).trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s;
}

// Phase A: HUMAN PRESCRIPTION DRUG + OTC accepted; animal drugs / cosmetics skipped
export function isAcceptedLabelType(labelType) {
    if (!labelType) return false;
    const lt = String(labelType).toUpperCase();
    return lt.includes('HUMAN PRESCRIPTION') || lt.includes('HUMAN OTC');
}

export function buildNullSections() {
    const sections = {};
    for (const name of Object.values(LOINC_SECTIONS)) sections[name] = null;
    return sections;
}

export async function fetchJson(url) {
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

export async function fetchBinary(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Sciweon/0.5 (+https://sciweon.com; scientific data infrastructure)',
        },
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

export async function listSplPage(startDate, page) {
    const params = new URLSearchParams({
        startdate: startDate,
        pagesize: String(LIST_PAGE_SIZE),
        page: String(page),
        labeltype: 'HUMAN PRESCRIPTION DRUG',
    });
    const data = await fetchJson(`${DAILYMED_BASE}/spls.json?${params}`);
    // DailyMed v2 uses `total_elements` not `total`; see dailymed-adapter.js
    // checkForUpdates note. Bug was symmetric across probe + list paths —
    // bootstrap fetch loop terminated on page 1 (maxPage = 0 / 0 = NaN).
    return {
        total: data.metadata?.total_elements ?? 0,
        items: Array.isArray(data.data) ? data.data : [],
    };
}

export async function fetchLabelMeta(setid) {
    const data = await fetchJson(`${DAILYMED_BASE}/spls/${encodeURIComponent(setid)}.json`);
    return data.data ?? null;
}

// Cycle 21 PR #7 — detect ZIP magic (PK\x03\x04) so a future endpoint
// drift surfaces as an explicit error instead of EOCD parser noise.
// HTML/empty responses (the symptom of the /archives/{setid}.zip 302) get
// caught here with the URL in the message, making the next break debuggable
// in one line. [[feedback_cross_cycle_silent_data_loss]] adjacent defense.
function assertZipMagic(buf, url) {
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
        const head = buf.slice(0, 32).toString('utf-8').replace(/[\x00-\x1f]/g, '?');
        throw new Error(`ZIP magic mismatch (got first 32 bytes: "${head}…") from ${url}`);
    }
}

export async function fetchSections(setid) {
    try {
        const encoded = encodeURIComponent(setid);
        const url = `${DAILYMED_GETFILE}?setid=${encoded}&type=zip&name=${encoded}`;
        const zipBuf = await fetchBinary(url);
        assertZipMagic(zipBuf, url);
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
