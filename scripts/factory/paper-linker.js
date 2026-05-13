/**
 * Paper Linker V0.1 — links Compound → Papers (OpenAlex).
 *
 * Strategy:
 *   1. Load enriched compounds (post cross-source-linker)
 *   2. For each, search OpenAlex by compound name
 *   3. Normalize papers, link via name match (mention_confidence)
 *   4. Flag retracted papers for V0.4 Negative Evidence
 *   5. Extract NCT IDs from abstracts (paper ↔ trial cross-link)
 *
 * Outputs:
 *   output/linked/papers.jsonl          — Paper entities
 *   output/linked/paper-links.jsonl     — Compound → Paper associations
 *   output/linked/retracted-papers.jsonl — V0.4 Negative Evidence raw
 */

import fs from 'fs/promises';
import path from 'path';
import { search, normalize as normalizePaper } from '../ingestion/adapters/openalex-adapter.js';
import { loadIndex as loadRetractionIndex, lookup as lookupRetraction } from '../ingestion/adapters/retraction-watch-adapter.js';
import { PAPER_SCHEMA } from '../../src/lib/schemas/paper.js';
import { gate } from './lib/validation-gate.js';

/**
 * Apply Retraction Watch PRIMARY FACTS to a normalized paper.
 * Reason categorization is V0.4 — not consumed here.
 * Mutates paper in place. Returns true if a retraction was applied.
 */
function applyRetraction(paper, rwIndex) {
    const info = lookupRetraction(paper, rwIndex);
    if (!info) return false;
    paper.is_retracted = true;
    paper.retraction_doi = info.retraction_doi || null;
    paper.retraction_date = info.retraction_date || null;
    paper.retraction_nature = info.nature || null;
    paper.retraction_source = 'crossref_retraction_watch';
    return true;
}

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '50');
const PAPERS_PER_COMPOUND = parseInt(process.argv.find(a => a.startsWith('--per-compound='))?.split('=')[1] || '25');
const INPUT = process.argv.find(a => a.startsWith('--input='))?.split('=')[1]
    || './output/linked/compounds-enriched.jsonl';
const CLINICAL_ONLY = process.argv.includes('--clinical-only');
const OUTPUT_DIR = './output/linked';
const REQUEST_DELAY_MS = 100; // OpenAlex is fast + has polite pool

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadCompounds(file) {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function getSearchName(compound) {
    // For OpenAlex: prefer specific name over generic IUPAC (too long, low signal)
    if (compound.synonyms && compound.synonyms.length > 0) {
        // Use shortest synonym (usually most common/specific name)
        const sorted = [...compound.synonyms].sort((a, b) => a.length - b.length);
        return sorted[0];
    }
    if (compound.iupac_name && compound.iupac_name.length < 100) return compound.iupac_name;
    return `CID ${compound.pubchem_cid}`;
}

async function main() {
    console.log(`[PAPER-LINKER] V0.1 — input: ${INPUT}, limit: ${LIMIT}, per-compound: ${PAPERS_PER_COMPOUND}`);
    if (CLINICAL_ONLY) console.log(`[PAPER-LINKER] Filter: max_phase >= 1`);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Load Retraction Watch canonical index (auto-syncs if stale)
    const rwIndex = await loadRetractionIndex();
    console.log(`[PAPER-LINKER] Retraction Watch: ${rwIndex.record_count} records loaded (DOI:${rwIndex.with_doi}, PMID:${rwIndex.with_pmid})`);

    let compounds = await loadCompounds(INPUT);
    if (CLINICAL_ONLY) {
        compounds = compounds.filter(c => c.drug_status?.max_phase != null && c.drug_status.max_phase >= 1);
    }
    compounds = compounds.slice(0, LIMIT);
    console.log(`[PAPER-LINKER] Processing ${compounds.length} compounds`);

    const allPapers = new Map(); // openalex_id → Paper entity (dedup)
    const paperLinks = [];
    const retractedPapers = [];
    let processed = 0;
    let totalTrialMentions = 0;

    for (const compound of compounds) {
        const searchName = getSearchName(compound);
        const rawPapers = await search(searchName, PAPERS_PER_COMPOUND);

        for (const raw of rawPapers) {
            const paper = normalizePaper(raw, compound.id, 'concept_match');
            if (!paper) continue;

            // Cross-validate retraction status against Retraction Watch (canonical)
            applyRetraction(paper, rwIndex);

            const result = gate(paper, PAPER_SCHEMA, `paper:${paper.id}`);
            if (!result.passed) continue;

            const key = paper.openalex_id || paper.doi;
            if (!key) continue;

            if (!allPapers.has(key)) {
                allPapers.set(key, paper);
                if (paper.is_retracted) {
                    retractedPapers.push({
                        paper_id: paper.id,
                        openalex_id: paper.openalex_id,
                        doi: paper.doi,
                        title: paper.title,
                        compound_id: compound.id,
                        compound_name: searchName,
                        publication_year: paper.publication_year,
                    });
                }
                if (paper.mentioned_trial_ids?.length > 0) totalTrialMentions += paper.mentioned_trial_ids.length;
            }
            paperLinks.push({
                compound_id: compound.id,
                paper_id: paper.id,
                openalex_id: paper.openalex_id,
                doi: paper.doi,
                mention_confidence: 70,
                extraction_method: 'concept_match',
            });
        }

        processed++;
        if (processed % 5 === 0 || processed === compounds.length) {
            console.log(`[PAPER-LINKER] Progress: ${processed}/${compounds.length} | unique papers: ${allPapers.size} | retracted: ${retractedPapers.length} | NCT mentions: ${totalTrialMentions}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    const papersFile = path.join(OUTPUT_DIR, 'papers.jsonl');
    const linksFile = path.join(OUTPUT_DIR, 'paper-links.jsonl');
    const retractedFile = path.join(OUTPUT_DIR, 'retracted-papers.jsonl');

    await fs.writeFile(papersFile, [...allPapers.values()].map(p => JSON.stringify(p)).join('\n'));
    await fs.writeFile(linksFile, paperLinks.map(l => JSON.stringify(l)).join('\n'));
    await fs.writeFile(retractedFile, retractedPapers.map(r => JSON.stringify(r)).join('\n'));

    const retractRate = allPapers.size > 0 ? (100 * retractedPapers.length / allPapers.size).toFixed(2) : 0;

    console.log(`\n[PAPER-LINKER] ✅ Complete`);
    console.log(`  Compounds processed:    ${processed}`);
    console.log(`  Unique papers:          ${allPapers.size}`);
    console.log(`  Compound-paper links:   ${paperLinks.length}`);
    console.log(`  Retracted papers:       ${retractedPapers.length} (${retractRate}%) ⭐ V0.4 Negative Evidence`);
    console.log(`  NCT IDs in abstracts:   ${totalTrialMentions} (paper↔trial cross-link signals)`);
    console.log(`\n  Outputs:`);
    console.log(`    ${papersFile}`);
    console.log(`    ${linksFile}`);
    console.log(`    ${retractedFile}`);
}

main().catch(err => { console.error('[PAPER-LINKER] Fatal:', err); process.exit(1); });
