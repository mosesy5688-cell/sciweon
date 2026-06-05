/**
 * Paper Linker V0.2 (PR-B coverage-ceiling) -- links Compound -> Papers (OpenAlex).
 *
 * Per ELIGIBLE compound (cursored-advance + skip-if-fresh, see
 * lib/linker-coverage-runner.js): search OpenAlex, normalize, cross-validate
 * against Semantic Scholar (batch DOI), flag retracted papers (Negative
 * Evidence), extract NCT IDs from abstracts (paper <-> trial cross-link).
 *
 * ===== PR-B: O(50) COVERAGE-CEILING FIX (stage-audit finding B2) =====
 * BEFORE: a fixed `--limit=50` + slice(0, 50); the F3 orchestrator passes NO
 * argv, so every daily run re-queried only the OLDEST 50 of the ~16,011-paper
 * corpus -- the rest were NEVER reached, the linker exited 0, so the coverage
 * CEILING was SILENT (violating the preserve-all ruling). AFTER: a CURSORED-
 * ADVANCE drain walks ALL compounds across runs; a per-compound freshness STAMP
 * (queried-at) skips compounds queried within the window (default 45d) and
 * advances to un-queried / stale ones. Bounded pMap concurrency + the shared
 * OpenAlex token bucket (10 req/s polite pool) pace the API. A coverage-invariant
 * hard-fail (eligible>0 && queried==0 -> THROW) refuses to exit 0 on a frozen
 * cursor. CADENCE, never a cap; no Top-N / relevance / volume cut anywhere.
 *
 * Stamp storage (deviation flagged in the PR body): the queried-at stamp lives in
 * R2 state/linker-query-stamps/paper_linker.jsonl, NOT compound.linkage.* -- see
 * trial-linker.js header for the full rationale (parallel linkers + deepMerge
 * wholesale `linkage` replace + the run-before-merge read-after-write gap).
 *
 * Usage:
 *   node scripts/factory/paper-linker.js [--input=...] [--per-compound=25]
 *     [--clinical-only] [--freshness-days=N] [--chunk-size=N]
 * Output: output/linked/{papers,paper-links,retracted-papers}.jsonl
 *         R2 state/linker-query-stamps/paper_linker.jsonl (freshness state)
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { once } from 'events';
import path from 'path';
import { search, normalize as normalizePaper } from '../ingestion/adapters/openalex-adapter.js';
import { loadIndex as loadRetractionIndex } from '../ingestion/adapters/retraction-watch-adapter.js';
import { fetchByDoiBatch as s2FetchByDoiBatch } from '../ingestion/adapters/semanticscholar-adapter.js';
import { scoreEntity } from './lib/confidence-scorer.js';
import { PAPER_SCHEMA } from '../../src/lib/schemas/paper.js';
import { gate } from './lib/validation-gate.js';
import { loadJsonlStrict, assertLoaded } from './lib/jsonl-io.js';
import { pMap } from './lib/p-map.js';
import { PAPER_RATE_LIMITER } from './lib/rate-limiter.js';
import { runCoverageStage } from './lib/linker-coverage-runner.js';
import { DEFAULT_PAPERS_FRESHNESS_DAYS, PAPERS_STAMP_FIELD } from './lib/linker-coverage.js';
import { enrichWithS2, applyRetraction } from './lib/paper-linker-helpers.js';

const LABEL = 'PAPER-LINKER';
const SOURCE = 'paper_linker';
const PAPERS_PER_COMPOUND = parseInt(process.argv.find(a => a.startsWith('--per-compound='))?.split('=')[1] || '25');
const INPUT = process.argv.find(a => a.startsWith('--input='))?.split('=')[1]
    || './output/linked/compounds-enriched.jsonl';
const CLINICAL_ONLY = process.argv.includes('--clinical-only');
const OUTPUT_DIR = './output/linked';
const FRESHNESS_DAYS = Number(process.argv.find(a => a.startsWith('--freshness-days='))?.split('=')[1])
    || Number(process.env.PAPER_FRESHNESS_DAYS) || DEFAULT_PAPERS_FRESHNESS_DAYS;
const CHUNK_SIZE_OVERRIDE = Number(process.argv.find(a => a.startsWith('--chunk-size='))?.split('=')[1]) || null;
const OPENALEX_CONCURRENCY = Number(process.env.PAPER_CONCURRENCY) || 6;

async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) {
        if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
}

function getSearchName(compound) {
    if (compound.synonyms && compound.synonyms.length > 0) {
        const sorted = [...compound.synonyms].sort((a, b) => a.length - b.length);
        return sorted[0];
    }
    if (compound.iupac_name && compound.iupac_name.length < 100) return compound.iupac_name;
    return `CID ${compound.pubchem_cid}`;
}

/**
 * Query + normalize papers for ONE compound (no shared-state mutation -- safe in
 * a pMap worker). Returns per-compound papers/links/retractions; the caller folds
 * them into the shared dedup maps synchronously after pMap returns.
 */
async function processOneCompound(compound, rwIndex) {
    const searchName = getSearchName(compound);
    await PAPER_RATE_LIMITER.acquire(); // bound the true OpenAlex request rate
    const rawPapers = await search(searchName, PAPERS_PER_COMPOUND);

    const normalized = [];
    for (const raw of rawPapers) {
        const paper = normalizePaper(raw, compound.id, 'concept_match');
        if (!paper) continue;
        applyRetraction(paper, rwIndex);
        normalized.push(paper);
    }

    const dois = normalized.map(p => p.doi).filter(Boolean);
    const s2Map = dois.length > 0 ? await s2FetchByDoiBatch(dois) : new Map();
    let s2Enriched = 0;
    let s2Conflicts = 0;
    for (const paper of normalized) {
        if (enrichWithS2(paper, s2Map)) {
            s2Enriched++;
            if (paper.confidence?.cross_source_agreement?.conflicts?.length) s2Conflicts++;
        }
    }
    for (const paper of normalized) {
        if (paper.confidence) continue;
        const agreement = { structural_match: false, conflicts: [] };
        const scored = scoreEntity({ provenance: paper.provenance, confidence: { cross_source_agreement: agreement }, stats: {} });
        paper.confidence = { overall: scored.overall, method: scored.method, cross_source_agreement: agreement };
    }

    const papers = [];
    const links = [];
    const retracted = [];
    let trialMentions = 0;
    for (const paper of normalized) {
        if (!gate(paper, PAPER_SCHEMA, `paper:${paper.id}`).passed) continue;
        const key = paper.openalex_id || paper.doi;
        if (!key) continue;
        papers.push({ key, paper });
        if (paper.is_retracted) {
            retracted.push({
                paper_id: paper.id, openalex_id: paper.openalex_id, doi: paper.doi, title: paper.title,
                compound_id: compound.id, compound_name: searchName, publication_year: paper.publication_year,
            });
        }
        if (paper.mentioned_trial_ids?.length > 0) trialMentions += paper.mentioned_trial_ids.length;
        links.push({
            compound_id: compound.id, paper_id: paper.id, openalex_id: paper.openalex_id,
            doi: paper.doi, mention_confidence: 70, extraction_method: 'concept_match',
        });
    }
    return { compound, papers, links, retracted, trialMentions, s2Enriched, s2Conflicts };
}

// Query OpenAlex for one chunk, write the entity outputs, return queried ids.
function makeQueryChunk(rwIndex) {
    return async function queryChunk(slice, _nowIso) {
        const perCompound = await pMap(slice, OPENALEX_CONCURRENCY, c => processOneCompound(c, rwIndex));
        const allPapers = new Map(); // key -> Paper
        const paperLinks = [];
        const retractedPapers = [];
        const queriedIds = [];
        let totalTrialMentions = 0;
        let s2Enriched = 0;
        let s2Conflicts = 0;
        for (const r of perCompound) {
            queriedIds.push(r.compound.id);
            for (const { key, paper } of r.papers) if (!allPapers.has(key)) allPapers.set(key, paper);
            for (const link of r.links) paperLinks.push(link);
            for (const ret of r.retracted) retractedPapers.push(ret);
            totalTrialMentions += r.trialMentions;
            s2Enriched += r.s2Enriched;
            s2Conflicts += r.s2Conflicts;
        }
        const papersOut = [...allPapers.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        paperLinks.sort((a, b) => (a.compound_id + String(a.paper_id)).localeCompare(b.compound_id + String(b.paper_id)));
        retractedPapers.sort((a, b) => String(a.paper_id).localeCompare(String(b.paper_id)));

        await writeJsonl(path.join(OUTPUT_DIR, 'papers.jsonl'), papersOut);
        await writeJsonl(path.join(OUTPUT_DIR, 'paper-links.jsonl'), paperLinks);
        await writeJsonl(path.join(OUTPUT_DIR, 'retracted-papers.jsonl'), retractedPapers);

        const retractRate = papersOut.length > 0 ? (100 * retractedPapers.length / papersOut.length).toFixed(2) : 0;
        console.log(`[${LABEL}] this-run papers=${papersOut.length} links=${paperLinks.length} retracted=${retractedPapers.length} (${retractRate}%) NCT_mentions=${totalTrialMentions} s2=${s2Enriched}/${paperLinks.length} (conflicts ${s2Conflicts})`);
        return { queriedIds };
    };
}

async function main() {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    console.log(`[${LABEL}] V0.2 PR-B cursored-advance | input: ${INPUT} | per-compound: ${PAPERS_PER_COMPOUND} | freshness=${FRESHNESS_DAYS}d | concurrency=${OPENALEX_CONCURRENCY}`);
    if (CLINICAL_ONLY) console.log(`[${LABEL}] Filter: max_phase >= 1`);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const rwIndex = await loadRetractionIndex();
    console.log(`[${LABEL}] Retraction Watch: ${rwIndex.record_count} records loaded (DOI:${rwIndex.with_doi}, PMID:${rwIndex.with_pmid})`);

    let compounds = await loadJsonlStrict(INPUT);
    assertLoaded(compounds, LABEL, INPUT);
    if (CLINICAL_ONLY) {
        compounds = compounds.filter(c => c.drug_status?.max_phase != null && c.drug_status.max_phase >= 1);
    }

    await runCoverageStage({
        label: LABEL, source: SOURCE, stampField: PAPERS_STAMP_FIELD,
        freshnessDays: FRESHNESS_DAYS, chunkSizeOverride: CHUNK_SIZE_OVERRIDE,
        compounds, nowMs, nowIso, queryChunk: makeQueryChunk(rwIndex),
    });
    console.log(`[${LABEL}] SUCCESS`);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'));
if (isDirectRun) {
    main().catch(err => { console.error(`[${LABEL}] Fatal:`, err); process.exit(1); });
}

export { main, processOneCompound };
