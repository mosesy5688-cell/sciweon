/**
 * Bidirectional Linker V0.1 — Paper ↔ Trial cross-reference resolution.
 *
 * Runs after trial-linker + paper-linker. Closes the loop:
 *   - Trial.references.pmid (from CT.gov referencesModule) → fetch papers
 *   - Existing papers merged with mentioned_trial_ids
 *   - New papers added with extraction_method='trial_reference'
 *   - Compound linkage propagated from trial.interventions[].compound_id
 *
 * Why bidirectional matters:
 *   Paper.abstract NCT regex extraction is sparse (~1.8% mention rate).
 *   CT.gov references are the authoritative paper↔trial backlink.
 *
 * Inputs:
 *   output/linked/trials.jsonl
 *   output/linked/papers.jsonl
 *   output/linked/paper-links.jsonl
 * Outputs (in place):
 *   output/linked/papers.jsonl       — updated mentioned_trial_ids + new trial-ref papers
 *   output/linked/paper-links.jsonl  — appended compound→paper links via trials
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchByPmidBatch, normalize as normalizePaper } from '../ingestion/adapters/openalex-adapter.js';
import { loadIndex as loadRetractionIndex, lookup as lookupRetraction } from '../ingestion/adapters/retraction-watch-adapter.js';
import { PAPER_SCHEMA } from '../../src/lib/schemas/paper.js';
import { gate } from './lib/validation-gate.js';
import { loadJsonlStrict, assertLoaded } from './lib/jsonl-io.js';

const OUTPUT_DIR = './output/linked';
const LABEL = 'BIDIR-LINKER';

async function writeJsonl(file, records) {
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
}

function buildPmidToNctMap(trials) {
    const map = new Map(); // pmid → Set<nct_id>
    for (const t of trials) {
        for (const ref of t.references ?? []) {
            if (!ref.pmid) continue;
            if (!map.has(ref.pmid)) map.set(ref.pmid, new Set());
            map.get(ref.pmid).add(t.nct_id);
        }
    }
    return map;
}

function buildNctToCompoundMap(trials) {
    const map = new Map(); // nct_id → Set<compound_id>
    for (const t of trials) {
        for (const intervention of t.interventions ?? []) {
            if (intervention.compound_id) {
                if (!map.has(t.nct_id)) map.set(t.nct_id, new Set());
                map.get(t.nct_id).add(intervention.compound_id);
            }
        }
    }
    return map;
}

async function main() {
    console.log('[BIDIR-LINKER] V0.1 — paper ↔ trial cross-reference resolution');

    const papersPath = path.join(OUTPUT_DIR, 'papers.jsonl');
    const trials = await loadJsonlStrict(path.join(OUTPUT_DIR, 'trials.jsonl'));
    const papers = await loadJsonlStrict(papersPath);
    const paperLinks = await loadJsonlStrict(path.join(OUTPUT_DIR, 'paper-links.jsonl'));
    console.log(`[BIDIR-LINKER] Loaded: ${trials.length} trials, ${papers.length} papers, ${paperLinks.length} links`);

    // HALT loud (no silent data loss): papers.jsonl is overwritten in place and is always produced,
    // so 0 papers is an anomaly -- refuse to truncate it. paper-links.jsonl is NOT guarded (it may
    // be legitimately empty); it relies on loadJsonlStrict's parse-protection only. Runs BEFORE the
    // terminal writeJsonl.
    assertLoaded(papers, LABEL, papersPath);

    const rwIndex = await loadRetractionIndex({ allowStale: true });

    const pmidToNct = buildPmidToNctMap(trials);
    const nctToCompound = buildNctToCompoundMap(trials);
    console.log(`[BIDIR-LINKER] Trial references: ${pmidToNct.size} unique PMIDs across ${trials.length} trials`);

    // Index existing papers by openalex_id and pmid
    const paperByOpenalexId = new Map();
    const paperByPmid = new Map();
    for (const p of papers) {
        if (p.openalex_id) paperByOpenalexId.set(p.openalex_id, p);
        if (p.pmid) paperByPmid.set(p.pmid, p);
    }

    // 1. Merge mentioned_trial_ids into existing papers (where pmid matches)
    let existingMergedCount = 0;
    for (const [pmid, nctSet] of pmidToNct) {
        const paper = paperByPmid.get(pmid);
        if (paper) {
            const existing = new Set(paper.mentioned_trial_ids ?? []);
            const before = existing.size;
            for (const nct of nctSet) existing.add(nct);
            if (existing.size > before) {
                paper.mentioned_trial_ids = [...existing];
                existingMergedCount++;
            }
        }
    }
    console.log(`[BIDIR-LINKER] Merged trial mentions into ${existingMergedCount} existing papers`);

    // 2. Fetch new papers for PMIDs not already in papers.jsonl
    const missingPmids = [...pmidToNct.keys()].filter(p => !paperByPmid.has(p));
    console.log(`[BIDIR-LINKER] Fetching ${missingPmids.length} new papers from OpenAlex by PMID`);

    const rawPapers = await fetchByPmidBatch(missingPmids);
    console.log(`[BIDIR-LINKER] OpenAlex returned ${rawPapers.length}/${missingPmids.length} papers`);

    let addedCount = 0;
    let addedLinks = 0;
    for (const raw of rawPapers) {
        const paper = normalizePaper(raw, null, 'trial_reference');
        if (!paper || !paper.pmid) continue;

        // Apply Retraction Watch PRIMARY FACTS (reason categorization is V0.4 scope)
        const rwInfo = lookupRetraction(paper, rwIndex);
        if (rwInfo) {
            paper.is_retracted = true;
            paper.retraction_doi = rwInfo.retraction_doi || null;
            paper.retraction_date = rwInfo.retraction_date || null;
            paper.retraction_nature = rwInfo.nature || null;
            paper.retraction_source = 'crossref_retraction_watch';
        }

        const nctSet = pmidToNct.get(paper.pmid);
        if (!nctSet || nctSet.size === 0) continue;

        // Mentioned trials = trials that cited this paper
        paper.mentioned_trial_ids = [...nctSet];

        // Mentioned compounds = all compounds linked to those trials
        const compoundSet = new Set();
        for (const nct of nctSet) {
            for (const cid of (nctToCompound.get(nct) ?? [])) compoundSet.add(cid);
        }
        paper.mentioned_compounds = [...compoundSet].map(cid => ({
            compound_id: cid,
            mention_confidence: 85, // CT.gov references are higher-confidence than abstract NLP
            extraction_method: 'trial_reference',
        }));

        // Dedup: if this openalex_id already in papers (shouldn't be — was filtered by pmid)
        if (paper.openalex_id && paperByOpenalexId.has(paper.openalex_id)) {
            const existing = paperByOpenalexId.get(paper.openalex_id);
            const merged = new Set([...(existing.mentioned_trial_ids ?? []), ...paper.mentioned_trial_ids]);
            existing.mentioned_trial_ids = [...merged];
            continue;
        }

        // gate() throws in REJECT mode on primary-source violations and
        // returns {passed: true, ...} otherwise (incl. derived-only warnings
        // per V0.5.7 H2b-5 tier separation). The legacy `if (!result.passed)
        // continue` guard was unreachable dead code and removed.
        gate(paper, PAPER_SCHEMA, `paper:${paper.id}`);

        papers.push(paper);
        paperByOpenalexId.set(paper.openalex_id, paper);
        paperByPmid.set(paper.pmid, paper);
        addedCount++;

        // Add paper-links for each linked compound
        for (const cid of compoundSet) {
            paperLinks.push({
                compound_id: cid,
                paper_id: paper.id,
                openalex_id: paper.openalex_id,
                doi: paper.doi,
                mention_confidence: 85,
                extraction_method: 'trial_reference',
            });
            addedLinks++;
        }
    }
    console.log(`[BIDIR-LINKER] Added ${addedCount} new papers from trial references, ${addedLinks} new compound→paper links`);

    // 3. Stats
    const papersWithTrials = papers.filter(p => p.mentioned_trial_ids?.length > 0).length;
    console.log(`[BIDIR-LINKER] After merge: ${papersWithTrials}/${papers.length} papers have mentioned_trial_ids (${(100 * papersWithTrials / papers.length).toFixed(1)}%)`);

    // 4. Write outputs
    await writeJsonl(path.join(OUTPUT_DIR, 'papers.jsonl'), papers);
    await writeJsonl(path.join(OUTPUT_DIR, 'paper-links.jsonl'), paperLinks);

    console.log(`\n[BIDIR-LINKER] ✅ Complete`);
    console.log(`  Existing papers updated:   ${existingMergedCount}`);
    console.log(`  New trial-reference papers: ${addedCount}`);
    console.log(`  New compound→paper links:   ${addedLinks}`);
    console.log(`  Papers with trial mentions: ${papersWithTrials}/${papers.length}`);
}

main().catch(err => { console.error('[BIDIR-LINKER] Fatal:', err); process.exit(1); });
