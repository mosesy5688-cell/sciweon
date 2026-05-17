/**
 * Retraction Watch Adapter — Sciweon V0.1
 *
 * Canonical source for paper retraction status + reasons.
 * Replaces unreliable OpenAlex `is_retracted` flag.
 *
 * Source: Crossref's Retraction Watch dataset (CC BY 4.0)
 *   https://gitlab.com/crossref/retraction-watch-data
 *
 * Strategy:
 *   1. sync() — one-time download of CSV (~60MB, ~50K records), parse to local index
 *   2. loadIndex() — load JSON index into memory (by DOI + PMID)
 *   3. lookup(paper) — return retraction info if matched, else null
 *
 * Cache: data/retraction_watch_index.json (refresh weekly via sync())
 */

import fs from 'fs/promises';
import path from 'path';

const RW_CSV_URL = 'https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv';
const INDEX_PATH = './data/retraction_watch_index.json';
const STALE_DAYS = 7;

// CSV columns (per RW schema 2024):
// 0:Record ID, 1:Title, 2:Subject, 3:Institution, 4:Journal, 5:Publisher,
// 6:Country, 7:Author, 8:URLS, 9:ArticleType, 10:RetractionDate, 11:RetractionDOI,
// 12:RetractionPubMedID, 13:OriginalPaperDate, 14:OriginalPaperDOI,
// 15:OriginalPaperPubMedID, 16:RetractionNature, 17:Reason, 18:Paywalled, 19:Notes

function parseCsvLine(line) {
    // Minimal CSV parser respecting double-quoted fields with embedded commas.
    const fields = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuote) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') inQuote = false;
            else cur += c;
        } else {
            if (c === '"') inQuote = true;
            else if (c === ',') { fields.push(cur); cur = ''; }
            else cur += c;
        }
    }
    fields.push(cur);
    return fields;
}

// Sciweon Compound/Paper schemas require DOI regex `^10\.\d{4,}/\S+$`.
// RW CSV occasionally has placeholder values ("unavailable", "n/a", etc.)
// in the RetractionDOI column. Strip URL prefix + validate format; return
// null on mismatch so downstream consumers don't propagate non-DOI strings
// into schema-bound fields (caused bidirectional-linker REJECT halt 2026-05-17).
const DOI_PATTERN = /^10\.\d{4,}\/\S+$/;

function normalizeDoi(doi) {
    if (!doi) return null;
    const s = String(doi).trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
    if (!s) return null;
    return DOI_PATTERN.test(s) ? s : null;
}

function parseDate(s) {
    // RW dates: M/D/YYYY 0:00
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    const [, mo, d, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Download CSV → build index → write to disk.
 */
export async function sync() {
    console.log(`[RETRACTION-WATCH] Downloading CSV from ${RW_CSV_URL}`);
    const res = await fetch(RW_CSV_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching Retraction Watch CSV`);
    const csv = await res.text();
    console.log(`[RETRACTION-WATCH] Got ${csv.length} bytes, parsing...`);

    const lines = csv.split('\n');
    const header = parseCsvLine(lines[0]);
    const colIdx = (name) => header.indexOf(name);
    const cDoi = colIdx('OriginalPaperDOI');
    const cPmid = colIdx('OriginalPaperPubMedID');
    const cReason = colIdx('Reason');
    const cDate = colIdx('RetractionDate');
    const cNature = colIdx('RetractionNature');
    const cTitle = colIdx('Title');
    const cJournal = colIdx('Journal');

    if (cDoi < 0 || cPmid < 0) throw new Error('Retraction Watch CSV schema unexpected (missing key columns)');

    // PRIMARY FACTS ONLY: retraction_doi (canonical proof from publisher),
    // retraction_date, retraction_nature. RW's "Reason" categorization
    // is intentionally NOT consumed — Sciweon's V0.4 classifier will compute
    // reason from the original retraction notice full text against our own
    // 6-category schema (SAFETY/EFFICACY/ENROLLMENT/FUNDING/LOGISTICS/BUSINESS).
    const cRetDoi = colIdx('RetractionDOI');
    const byDoi = {};
    const byPmid = {};
    let parsed = 0;
    let withDoi = 0;
    let withPmid = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim().length === 0) continue;
        const f = parseCsvLine(line);
        if (f.length < cNature + 1) continue;
        const doi = normalizeDoi(f[cDoi]);
        const pmid = f[cPmid] && /^\d+$/.test(f[cPmid].trim()) ? f[cPmid].trim() : null;
        const retractionDoi = normalizeDoi(f[cRetDoi]);
        const entry = {
            retraction_doi: retractionDoi,
            retraction_date: parseDate(f[cDate]),
            nature: f[cNature] || null,
            source: 'crossref_retraction_watch',
        };
        if (doi) { byDoi[doi] = entry; withDoi++; }
        if (pmid) { byPmid[pmid] = entry; withPmid++; }
        parsed++;
    }

    const index = {
        last_sync: new Date().toISOString(),
        record_count: parsed,
        with_doi: withDoi,
        with_pmid: withPmid,
        byDoi,
        byPmid,
    };

    await fs.mkdir(path.dirname(INDEX_PATH), { recursive: true });
    await fs.writeFile(INDEX_PATH, JSON.stringify(index));
    console.log(`[RETRACTION-WATCH] Indexed ${parsed} records (${withDoi} by DOI, ${withPmid} by PMID) → ${INDEX_PATH}`);
    return index;
}

/**
 * Load index from disk. Auto-syncs if missing or stale.
 */
export async function loadIndex({ allowStale = false } = {}) {
    try {
        const raw = await fs.readFile(INDEX_PATH, 'utf-8');
        const idx = JSON.parse(raw);
        const ageMs = Date.now() - new Date(idx.last_sync).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > STALE_DAYS && !allowStale) {
            console.log(`[RETRACTION-WATCH] Index ${ageDays.toFixed(1)} days old, re-syncing`);
            return await sync();
        }
        return idx;
    } catch {
        console.log(`[RETRACTION-WATCH] No local index, syncing fresh`);
        return await sync();
    }
}

/**
 * Lookup a paper. Tries DOI first (more reliable), then PMID.
 * Returns retraction info object or null.
 */
export function lookup(paper, index) {
    if (!paper || !index) return null;
    const doi = normalizeDoi(paper.doi);
    if (doi && index.byDoi[doi]) return index.byDoi[doi];
    if (paper.pmid && index.byPmid[paper.pmid]) return index.byPmid[paper.pmid];
    return null;
}
