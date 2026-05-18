/**
 * WHO-ATC Adapter V2 — Anatomical Therapeutic Chemical classification.
 *
 * Fetches the complete ATC class hierarchy from ChEMBL REST API.
 * Each record maps one level-5 ATC code to its full parent chain
 * and WHO drug name — used to enrich compound drug_status.atc_codes
 * with structured descriptions at all 5 classification levels.
 *
 * ATC updates are published annually by WHO; fallbackFullRefreshDays=30
 * ensures the local copy stays current without unnecessary downloads.
 *
 * sinceToken: YYYY-MM-DD of last successful fetch. null = never fetched.
 */

import { scoreDataPoint } from '../../factory/lib/confidence-scorer.js';

const CHEMBL_BASE = 'https://www.ebi.ac.uk/chembl/api/data';
const PAGE_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 20000;
const DELAY_MS = 500;

export const supportsIncremental     = true;
export const fallbackFullRefreshDays = 30;

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
    if (!raw?.level5) return null;
    const ts = new Date().toISOString();
    return {
        id: `sciweon::atc_class::${raw.level5}`,
        level1: raw.level1 ?? null,
        level1_description: raw.level1_description ?? null,
        level2: raw.level2 ?? null,
        level2_description: raw.level2_description ?? null,
        level3: raw.level3 ?? null,
        level3_description: raw.level3_description ?? null,
        level4: raw.level4 ?? null,
        level4_description: raw.level4_description ?? null,
        level5: raw.level5,
        who_name: raw.who_name ?? null,
        provenance: {
            sources: [{
                source: 'who_atc_via_chembl',
                source_id: raw.level5,
                timestamp: ts,
                extraction_method: 'chembl_rest_v1_atc_class',
            }],
            last_updated: ts,
        },
        confidence: {
            overall: scoreDataPoint(['chembl']),
            method: 'single_source_authoritative',
        },
    };
}

export async function checkForUpdates(sinceToken) {
    const today = todayIso();
    const hasUpdates = daysSince(sinceToken) >= fallbackFullRefreshDays;
    try {
        const data = await fetchJson(`${CHEMBL_BASE}/atc_class.json?limit=1&offset=0`);
        const count = data.page_meta?.total_count ?? 0;
        return { hasUpdates, count, nextSinceToken: today };
    } catch (e) {
        console.warn(`[WHO-ATC] checkForUpdates: ${e.message}`);
        return { hasUpdates, count: 0, nextSinceToken: sinceToken };
    }
}

export async function fetchIncremental(sinceToken) {
    const nextSinceToken = todayIso();
    const records = [];
    let offset = 0;
    let total = null;
    console.log('[WHO-ATC] Full ATC hierarchy download via ChEMBL');
    while (true) {
        let data;
        try {
            data = await fetchJson(`${CHEMBL_BASE}/atc_class.json?limit=${PAGE_LIMIT}&offset=${offset}`);
        } catch (e) {
            console.warn(`[WHO-ATC] page offset=${offset}: ${e.message}`);
            break;
        }
        const items = data.atc_classifications ?? data.atc_class ?? [];
        if (total === null) {
            total = data.page_meta?.total_count ?? 0;
            console.log(`[WHO-ATC] Total ATC classes: ${total}`);
        }
        if (items.length === 0) break;
        for (const raw of items) {
            const rec = normalize(raw);
            if (rec) records.push(rec);
        }
        offset += items.length;
        if (total !== null && offset >= total) break;
        await sleep(DELAY_MS);
    }
    console.log(`[WHO-ATC] Done: ${records.length} ATC classes fetched`);
    return { records, nextSinceToken };
}
