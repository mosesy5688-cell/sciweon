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

// Cycle 21 PR #8: scope shrink. Previously today-7d, which on first-ever
// deploy tried to pull 7-day backlog. Combined with the DailyMed v2
// server-side `startdate` filter being **completely ignored** (verified
// 2026-05-22: queries with startdate=2025-01-01 and startdate=2026-05-22
// return identical responses — server returns full 156505-label corpus
// sorted by published_date desc), the bootstrap loop tried to ingest the
// entire corpus and would time out the GHA 6h job.
//
// New design: incremental adapter only handles "today + 1-day overlap".
// Historical / full-corpus ingest is delegated to a separate bulk-harvest
// workflow (PLANNED, tracked in SCIWEON_BULK_ACQUISITION_TRACKER.md).
// Daily cron now pulls ~50-200 freshly-published labels in 1-2 minutes.
export function bootstrapSince() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

const MONTH_MAP = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

// MM/DD/YYYY or YYYY-MM-DD or "Month DD, YYYY" → YYYY-MM-DD
// Cycle 21 PR #8: added textual-month branch. DailyMed API returns
// "May 21, 2026" for published_date — the old regex chain dropped to the
// `return s` fallback, breaking lexicographic date comparison needed for
// client-side cutoff (the fix for the broken server-side startdate
// filter). Verified live 2026-05-22.
export function normalizeDailyMedDate(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr).trim();
    const mNum = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mNum) return `${mNum[3]}-${mNum[1].padStart(2, '0')}-${mNum[2].padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const mText = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (mText) {
        const mm = MONTH_MAP[mText[1].toLowerCase()];
        if (mm) return `${mText[3]}-${mm}-${mText[2].padStart(2, '0')}`;
    }
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
