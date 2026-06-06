/**
 * Search Index Builder — V0.5.3 (Sprint 1a rework per §10 simplified arch).
 *
 * REPLACES SQLite FTS5 approach with plain JSON inverted index. Original
 * FTS5 design was a mechanical transfer from ai-nexus that didn't fit
 * sciweon's API-only function (no SSR rendering = no SQL JOIN/BM25 needed).
 * See feedback_pattern_transfer_function_match for the framing correction.
 *
 * F5 (PR-COMPOUND-GUARD): NO worker reads this sciweon-search-index.json output
 * -- compounds-search.jsonl.gz (compound-projection-builder.js) supersedes it
 * for the worker compound-search path. This builder is a dormant duplicate; its
 * removal is deferred (cleanup PR), not done here.
 *
 * Output: ./output/linked/sciweon-search-index.json
 * Format (single file with per-type indices):
 *   {
 *     "version": "0.5.3",
 *     "built_at": ISO timestamp,
 *     "compounds": { "tokens": {token: [ids]}, "meta": {id: {name, snippet}} },
 *     "trials":    { "tokens": {token: [ids]}, "meta": {id: {title, status}} },
 *     "papers":    { "tokens": {token: [ids]}, "meta": {id: {title, year}} }
 *   }
 *
 * Worker query path: load JSON on cold start, parse to Maps, do O(1) lookup
 * + set intersection for multi-term queries. No SQLite engine, no WASM, no VFS.
 *
 * Scale envelope (per §10):
 *   Up to ~250K compounds: JSON Map approach OK (decompressed ~50MB in V8)
 *   1M+ compounds: need to switch to SQLite FTS5 + R2RangeVFS (defer to V0.6+)
 *   For now (25K cumulative, 1M Tier 1 Core target), JSON is sufficient.
 *
 * Tier 2 (111M PubChem stub) intentionally NOT indexed — would explode
 * Worker memory at 1GB+. Agent queries Tier 2 only by exact CID, not name.
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';

const LINKED_DIR = './output/linked';
const OUTPUT_FILE = 'sciweon-search-index.json';
const MIN_TOKEN_LEN = 2;
const MAX_TOKEN_LEN = 50;
const MAX_SNIPPET_LEN = 200;

// Tokenize: lowercase, strip punctuation, keep alphanumeric + basic unicode.
// Conservative — Sciweon doesn't need fuzzy/phonetic; exact + multi-word.
function tokenize(text) {
    if (!text) return [];
    return String(text).toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length >= MIN_TOKEN_LEN && t.length <= MAX_TOKEN_LEN);
}

function uniqueTokens(...parts) {
    const seen = new Set();
    for (const part of parts) {
        for (const tok of tokenize(part)) seen.add(tok);
    }
    return [...seen];
}

function streamJsonl(filePath) {
    return readline.createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });
}

async function safeReadJsonl(filePath, onRecord) {
    try { await fs.access(filePath); }
    catch { console.log(`[SEARCH-INDEX]   ${path.basename(filePath)}: file absent, skipping`); return 0; }
    let parsedCount = 0;
    const rl = streamJsonl(filePath);
    for await (const line of rl) {
        if (!line.trim()) continue;
        try { onRecord(JSON.parse(line)); parsedCount++; }
        catch { /* skip malformed */ }
    }
    return parsedCount;
}

function deriveCompoundName(rec) {
    if (Array.isArray(rec.synonyms) && rec.synonyms.length > 0 && rec.synonyms[0]) {
        return String(rec.synonyms[0]).slice(0, MAX_SNIPPET_LEN);
    }
    if (rec.iupac_name) return String(rec.iupac_name).slice(0, MAX_SNIPPET_LEN);
    return `PubChem CID:${rec.pubchem_cid || 'unknown'}`;
}

function deriveCompoundSnippet(rec) {
    const parts = [];
    if (rec.molecular_formula) parts.push(rec.molecular_formula);
    if (Array.isArray(rec.synonyms) && rec.synonyms.length > 1) {
        parts.push(`aka: ${rec.synonyms.slice(1, 4).join(', ')}`);
    }
    return parts.join(' — ').slice(0, MAX_SNIPPET_LEN);
}

function makeBucket() {
    return { tokens: Object.create(null), meta: Object.create(null) };
}

function addToken(bucket, token, id) {
    const list = bucket.tokens[token];
    if (list) list.push(id);
    else bucket.tokens[token] = [id];
}

async function buildCompoundIndex(bucket, inputDir) {
    const file = path.join(inputDir, 'compounds-enriched.jsonl');
    let inserted = 0;
    await safeReadJsonl(file, rec => {
        if (!rec.id || !rec.inchi_key) return;
        const tokens = uniqueTokens(
            deriveCompoundName(rec),
            Array.isArray(rec.synonyms) ? rec.synonyms.slice(0, 50).join(' ') : '',
            rec.iupac_name,
        );
        for (const t of tokens) addToken(bucket, t, rec.id);
        bucket.meta[rec.id] = {
            name: deriveCompoundName(rec),
            snippet: deriveCompoundSnippet(rec),
        };
        inserted++;
    });
    return inserted;
}

async function buildTrialIndex(bucket, inputDir) {
    const file = path.join(inputDir, 'trials.jsonl');
    let inserted = 0;
    await safeReadJsonl(file, rec => {
        if (!rec.id) return;
        const title = String(rec.brief_title || rec.official_title || rec.title || '').slice(0, MAX_SNIPPET_LEN);
        const conditions = Array.isArray(rec.conditions) ? rec.conditions.slice(0, 30).join(' ') : '';
        const interventions = Array.isArray(rec.interventions)
            ? rec.interventions.slice(0, 30).map(i => typeof i === 'string' ? i : i?.name || '').filter(Boolean).join(' ')
            : '';
        const tokens = uniqueTokens(title, conditions, interventions);
        for (const t of tokens) addToken(bucket, t, rec.id);
        bucket.meta[rec.id] = {
            title,
            status: String(rec.status || '').slice(0, 50),
        };
        inserted++;
    });
    return inserted;
}

async function buildPaperIndex(bucket, inputDir) {
    const file = path.join(inputDir, 'papers.jsonl');
    let inserted = 0;
    await safeReadJsonl(file, rec => {
        if (!rec.id) return;
        const title = String(rec.title || '').slice(0, MAX_SNIPPET_LEN);
        const tokens = uniqueTokens(title);
        for (const t of tokens) addToken(bucket, t, rec.id);
        bucket.meta[rec.id] = {
            title,
            year: rec.publication_year || null,
        };
        inserted++;
    });
    return inserted;
}

export async function buildIndex({ outputPath, inputDir = LINKED_DIR }) {
    const startTime = Date.now();
    console.log('[SEARCH-INDEX] V0.5.3 — building JSON inverted index (per §10)');

    const compounds = makeBucket();
    const trials = makeBucket();
    const papers = makeBucket();

    const compoundCount = await buildCompoundIndex(compounds, inputDir);
    console.log(`[SEARCH-INDEX]   compounds: ${compoundCount} records, ${Object.keys(compounds.tokens).length} unique tokens`);
    const trialCount = await buildTrialIndex(trials, inputDir);
    console.log(`[SEARCH-INDEX]   trials:    ${trialCount} records, ${Object.keys(trials.tokens).length} unique tokens`);
    const paperCount = await buildPaperIndex(papers, inputDir);
    console.log(`[SEARCH-INDEX]   papers:    ${paperCount} records, ${Object.keys(papers.tokens).length} unique tokens`);

    const index = {
        version: '0.5.3',
        built_at: new Date().toISOString(),
        compounds,
        trials,
        papers,
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const serialized = JSON.stringify(index);
    await fs.writeFile(outputPath, serialized, 'utf-8');

    const stat = await fs.stat(outputPath);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[SEARCH-INDEX] Done: ${outputPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB raw) in ${elapsed}s`);
    return { compoundCount, trialCount, paperCount, sizeBytes: stat.size, elapsedSec: elapsed };
}

async function main() {
    const outputPath = path.join(LINKED_DIR, OUTPUT_FILE);
    await fs.mkdir(LINKED_DIR, { recursive: true });
    await buildIndex({ outputPath });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
    main().catch(err => { console.error('[SEARCH-INDEX] Fatal:', err); process.exit(1); });
}

export { OUTPUT_FILE };
