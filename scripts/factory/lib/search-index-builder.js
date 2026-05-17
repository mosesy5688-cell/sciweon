/**
 * Search Index Builder — Tier 1.5 V0.5.3
 *
 * Builds a SQLite FTS5 full-text index over Tier 1 cumulative aggregated
 * entities (compounds + trials + papers). Output is `sciweon-search.db`,
 * a single SQLite file that Worker reads via wa-sqlite + R2RangeVFS for
 * `GET /api/v1/search?q=...` Agent queries.
 *
 * Why this exists: Tier 0/1/2 are CID→entity lookup paths. Without an
 * inverted index, Agent's `search_compound("metformin")` would require
 * brute-force scan of cumulative aggregated (~2-5s for 1M Tier 1 +
 * impossible for 111M Tier 2). FTS5 sub-100ms latency with proper
 * sharding-by-table.
 *
 * Stack rationale: same pattern as ai-nexus `data/fts.db` (proven at
 * 150K+ entities, sub-50ms p95 via R2RangeVFS). Sciweon scope V0.7+:
 * Tier 1 entities only (~1M Top Core). Tier 2 bulk 111M not indexed
 * here (per §9.4 design — chemical synonym data not in bulk stub).
 *
 * Build context: runs as the LAST step of Stage 3, AFTER cumulative
 * merger (V0.5.2.1) has written the merged JSONL files to ./output/linked/.
 * Output is uploaded to R2 as part of aggregated bundle via Stage 3
 * uploadStage call.
 *
 * Memory budget: better-sqlite3 native binding; streaming JSONL parser
 * + batched (1000 records / transaction). Peak ~150MB for 1M compounds.
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';
import Database from 'better-sqlite3';

const LINKED_DIR = './output/linked';
const OUTPUT_FILE = 'sciweon-search.db';
const BATCH_SIZE = 1000;

// FTS5 schemas. UNINDEXED columns are stored but not tokenized — saves
// index space + ensures lookup-only fields (cid, inchi_key) don't bloat
// the inverted index.
const SCHEMAS = {
    compound_search: `CREATE VIRTUAL TABLE compound_search USING fts5(
        name,
        synonyms,
        iupac_name,
        cid UNINDEXED,
        inchi_key UNINDEXED,
        tier UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
    )`,
    trial_search: `CREATE VIRTUAL TABLE trial_search USING fts5(
        title,
        conditions,
        interventions,
        trial_id UNINDEXED,
        status UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
    )`,
    paper_search: `CREATE VIRTUAL TABLE paper_search USING fts5(
        title,
        doi UNINDEXED,
        paper_id UNINDEXED,
        publication_year UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
    )`,
};

function streamJsonl(filePath) {
    return readline.createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });
}

async function safeReadJsonl(filePath, onRecord) {
    try {
        await fs.access(filePath);
    } catch {
        console.log(`[SEARCH-INDEX]   ${path.basename(filePath)}: file absent, skipping`);
        return 0;
    }
    let count = 0;
    const rl = streamJsonl(filePath);
    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line);
            await onRecord(rec);
            count++;
        } catch {
            // Skip malformed lines (defensive; validation gate should prevent these)
        }
    }
    return count;
}

function extractCompoundName(rec) {
    // Priority: first non-empty synonym → iupac_name → "PubChem CID:N" fallback
    if (Array.isArray(rec.synonyms) && rec.synonyms.length > 0 && rec.synonyms[0]) {
        return String(rec.synonyms[0]).slice(0, 200);
    }
    if (rec.iupac_name) return String(rec.iupac_name).slice(0, 200);
    return `PubChem CID:${rec.pubchem_cid || 'unknown'}`;
}

function extractCompoundSynonyms(rec) {
    // Join all synonyms with space; cap at 4KB to keep FTS5 row reasonable
    if (!Array.isArray(rec.synonyms)) return '';
    return rec.synonyms.slice(0, 50).join(' ').slice(0, 4000);
}

function extractTrialTitle(rec) {
    // Trial schema: brief_title / official_title / id fallback
    return String(rec.brief_title || rec.official_title || rec.title || '').slice(0, 500);
}

function extractTrialConditions(rec) {
    if (!Array.isArray(rec.conditions)) return '';
    return rec.conditions.slice(0, 30).join(' ').slice(0, 2000);
}

function extractTrialInterventions(rec) {
    if (!Array.isArray(rec.interventions)) return '';
    return rec.interventions
        .slice(0, 30)
        .map(i => (typeof i === 'string' ? i : i?.name || ''))
        .filter(Boolean)
        .join(' ')
        .slice(0, 2000);
}

async function buildIndex({ outputPath, inputDir = LINKED_DIR }) {
    const startTime = Date.now();
    console.log('[SEARCH-INDEX] V0.5.3 — building Tier 1.5 FTS5 index');

    // Remove any prior file to ensure clean rebuild.
    try { await fs.unlink(outputPath); } catch { /* not present */ }

    const db = new Database(outputPath);

    // Bulk-insert pragmas (WAL faster for our pattern; we VACUUM at end).
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB page cache
    db.pragma('temp_store = MEMORY');

    for (const ddl of Object.values(SCHEMAS)) db.exec(ddl);

    const insertCompound = db.prepare(`INSERT INTO compound_search (name, synonyms, iupac_name, cid, inchi_key, tier) VALUES (?, ?, ?, ?, ?, ?)`);
    const insertTrial = db.prepare(`INSERT INTO trial_search (title, conditions, interventions, trial_id, status) VALUES (?, ?, ?, ?, ?)`);
    const insertPaper = db.prepare(`INSERT INTO paper_search (title, doi, paper_id, publication_year) VALUES (?, ?, ?, ?)`);

    const txCompound = db.transaction((batch) => { for (const r of batch) insertCompound.run(r); });
    const txTrial = db.transaction((batch) => { for (const r of batch) insertTrial.run(r); });
    const txPaper = db.transaction((batch) => { for (const r of batch) insertPaper.run(r); });

    async function indexFile(fname, mapFn, txFn) {
        const buffer = [];
        let insertedCount = 0;
        await safeReadJsonl(path.join(inputDir, fname), async (rec) => {
            const row = mapFn(rec);
            if (row) {
                buffer.push(row);
                insertedCount++;
                if (buffer.length >= BATCH_SIZE) {
                    txFn(buffer.splice(0, buffer.length));
                }
            }
        });
        if (buffer.length > 0) txFn(buffer);
        return insertedCount;
    }

    const compoundCount = await indexFile('compounds-enriched.jsonl', rec => {
        if (!rec.id || !rec.inchi_key) return null;
        return [
            extractCompoundName(rec),
            extractCompoundSynonyms(rec),
            String(rec.iupac_name || '').slice(0, 500),
            String(rec.id),
            String(rec.inchi_key),
            '1', // tier 1 (Top 1M Core); Tier 0 hot shard membership derived at API time
        ];
    }, txCompound);
    console.log(`[SEARCH-INDEX]   compound_search:  ${compoundCount} rows`);

    const trialCount = await indexFile('trials.jsonl', rec => {
        if (!rec.id) return null;
        return [
            extractTrialTitle(rec),
            extractTrialConditions(rec),
            extractTrialInterventions(rec),
            String(rec.id),
            String(rec.status || ''),
        ];
    }, txTrial);
    console.log(`[SEARCH-INDEX]   trial_search:     ${trialCount} rows`);

    const paperCount = await indexFile('papers.jsonl', rec => {
        if (!rec.id) return null;
        return [
            String(rec.title || '').slice(0, 500),
            String(rec.doi || ''),
            String(rec.id),
            String(rec.publication_year || ''),
        ];
    }, txPaper);
    console.log(`[SEARCH-INDEX]   paper_search:     ${paperCount} rows`);

    // VACUUM to compact + reduce final file size. FTS5 indexes compact well.
    db.exec('VACUUM');
    db.close();

    const stat = await fs.stat(outputPath);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[SEARCH-INDEX] Done: ${outputPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB) in ${elapsed}s`);
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

export { buildIndex, OUTPUT_FILE, SCHEMAS };
