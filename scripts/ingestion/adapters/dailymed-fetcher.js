/**
 * DailyMed HTTP + utility helpers — internal module for dailymed-adapter.js.
 * Not part of the DataSourceAdapterV2 public interface.
 */

import { parseSplSections, extractXmlFromZip, LOINC_SECTIONS } from '../../factory/lib/spl-parser.js';

export const DAILYMED_BASE    = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';
export const DAILYMED_ARCHIVE = 'https://dailymed.nlm.nih.gov/dailymed/archives';
const LIST_PAGE_SIZE      = 100;
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
    return {
        total: data.metadata?.total ?? 0,
        items: Array.isArray(data.data) ? data.data : [],
    };
}

export async function fetchLabelMeta(setid) {
    const data = await fetchJson(`${DAILYMED_BASE}/spls/${encodeURIComponent(setid)}.json`);
    return data.data ?? null;
}

export async function fetchSections(setid) {
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
