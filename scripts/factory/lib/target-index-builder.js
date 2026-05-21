/**
 * Target Index Builder — V0.6 (Wave C2-3, cycle 20).
 *
 * Sciweon's API today is compound-centric. This builder produces the
 * inverse index keyed by UniProt accession so the Worker can answer
 *   "which compounds, trials, negative-evidence signals concern target X?"
 * in O(1) without a snapshot-wide scan.
 *
 * Mirrors `search-index-builder.js` 100% — same stream pattern, same
 * single-JSON output, same lifecycle inside stage-3-aggregate.js.
 *
 * Coverage (per 2026-05-21 sampling probe, V0.4.3 snapshot):
 *   - 33.6% of bioactivities carry `target.uniprot_accession`
 *   - 66.4% are ChEMBL-only `target_id` — NOT INDEXED in v1
 *   - The uniprot-bearing subset is cross-source verified (ChEMBL + UniProt
 *     agreement, per BIOACTIVITY_SCHEMA L48-50)
 *
 * Output: ./output/linked/target-index.json
 * Format:
 *   {
 *     "version": "0.6.0",
 *     "built_at": ISO,
 *     "targets": {
 *       "<uniprot>": {
 *         "uniprot_accession": string,
 *         "protein_name": string|null,
 *         "gene_symbol":  string|null,
 *         "chembl_target_id": string|null,
 *         "organism": { "taxon_id": number|null, "scientific_name": string|null },
 *         "compound_ids":           string[],
 *         "bioactivity_ids":        string[],
 *         "trial_ids":              string[],
 *         "negative_evidence_ids":  string[]
 *       }, ...
 *     }
 *   }
 *
 * Determinism (Constitution V16.1 §7): all id arrays sorted via
 * String.prototype.localeCompare; uniprot keys serialized in sorted order.
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';

const LINKED_DIR = './output/linked';
const OUTPUT_FILE = 'target-index.json';
const VERSION = '0.6.0';

function streamJsonl(filePath) {
    return readline.createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });
}

async function safeReadJsonl(filePath, onRecord) {
    try { await fs.access(filePath); }
    catch { console.log(`[TARGET-INDEX]   ${path.basename(filePath)}: file absent, skipping`); return 0; }
    let parsedCount = 0;
    const rl = streamJsonl(filePath);
    for await (const line of rl) {
        if (!line.trim()) continue;
        try { onRecord(JSON.parse(line)); parsedCount++; }
        catch { /* skip malformed */ }
    }
    return parsedCount;
}

function makeEntry(uniprot) {
    return {
        uniprot_accession: uniprot,
        protein_name: null,
        gene_symbol: null,
        chembl_target_id: null,
        organism: { taxon_id: null, scientific_name: null },
        compound_ids: new Set(),
        bioactivity_ids: new Set(),
        trial_ids: new Set(),
        negative_evidence_ids: new Set(),
    };
}

/**
 * First-sighting wins for target metadata. Two bioactivities may carry
 * slightly different protein_name strings (capitalization, organism
 * suffix); deterministic sort below ensures the same first-sighting wins
 * across runs.
 */
function captureMeta(entry, target) {
    if (!entry.protein_name && target.protein_name) entry.protein_name = target.protein_name;
    if (!entry.gene_symbol && target.gene_symbol) entry.gene_symbol = target.gene_symbol;
    if (!entry.chembl_target_id && target.chembl_id) entry.chembl_target_id = target.chembl_id;
    if (entry.organism.taxon_id == null && target.organism?.taxon_id) {
        entry.organism.taxon_id = target.organism.taxon_id;
    }
    if (!entry.organism.scientific_name && target.organism?.scientific_name) {
        entry.organism.scientific_name = target.organism.scientific_name;
    }
}

/**
 * Pass 1 — bioactivities.jsonl: bucket by uniprot, capture meta, build
 * compound→uniprot reverse map for the trial fan-out pass.
 */
async function passBioactivities(inputDir, targets, compoundToUniprots) {
    const file = path.join(inputDir, 'bioactivities.jsonl');
    let processed = 0, indexed = 0;
    await safeReadJsonl(file, rec => {
        processed++;
        const uniprot = rec.target?.uniprot_accession;
        if (typeof uniprot !== 'string' || uniprot.length === 0) return;
        const compoundId = rec.compound_id;
        const bioId = rec.id;
        if (typeof compoundId !== 'string' || typeof bioId !== 'string') return;

        let entry = targets.get(uniprot);
        if (!entry) {
            entry = makeEntry(uniprot);
            targets.set(uniprot, entry);
        }
        captureMeta(entry, rec.target);
        entry.compound_ids.add(compoundId);
        entry.bioactivity_ids.add(bioId);

        let uniprotSet = compoundToUniprots.get(compoundId);
        if (!uniprotSet) {
            uniprotSet = new Set();
            compoundToUniprots.set(compoundId, uniprotSet);
        }
        uniprotSet.add(uniprot);
        indexed++;
    });
    return { processed, indexed };
}

/**
 * Pass 2 — trials.jsonl: for each trial, look at interventions[].compound_id;
 * if the compound is in the reverse map, attach the trial.id to every
 * uniprot the compound is active on.
 */
async function passTrials(inputDir, targets, compoundToUniprots) {
    const file = path.join(inputDir, 'trials.jsonl');
    let processed = 0, fannedOut = 0;
    await safeReadJsonl(file, rec => {
        processed++;
        const trialId = rec.id;
        if (typeof trialId !== 'string') return;
        const ivs = Array.isArray(rec.interventions) ? rec.interventions : [];
        for (const iv of ivs) {
            const cid = iv?.compound_id;
            if (typeof cid !== 'string') continue;
            const uniprots = compoundToUniprots.get(cid);
            if (!uniprots) continue;
            for (const uniprot of uniprots) {
                const entry = targets.get(uniprot);
                if (entry) {
                    entry.trial_ids.add(trialId);
                    fannedOut++;
                }
            }
        }
    });
    return { processed, fannedOut };
}

/**
 * Pass 3 — neg-evidence.jsonl: same fan-out via subject.compound_id.
 */
async function passNegEvidence(inputDir, targets, compoundToUniprots) {
    const file = path.join(inputDir, 'neg-evidence.jsonl');
    let processed = 0, fannedOut = 0;
    await safeReadJsonl(file, rec => {
        processed++;
        const negId = rec.id;
        if (typeof negId !== 'string') return;
        const cid = rec.subject?.compound_id;
        if (typeof cid !== 'string') return;
        const uniprots = compoundToUniprots.get(cid);
        if (!uniprots) return;
        for (const uniprot of uniprots) {
            const entry = targets.get(uniprot);
            if (entry) {
                entry.negative_evidence_ids.add(negId);
                fannedOut++;
            }
        }
    });
    return { processed, fannedOut };
}

function serializeEntry(entry) {
    return {
        uniprot_accession: entry.uniprot_accession,
        protein_name: entry.protein_name,
        gene_symbol: entry.gene_symbol,
        chembl_target_id: entry.chembl_target_id,
        organism: { ...entry.organism },
        compound_ids: [...entry.compound_ids].sort((a, b) => a.localeCompare(b)),
        bioactivity_ids: [...entry.bioactivity_ids].sort((a, b) => a.localeCompare(b)),
        trial_ids: [...entry.trial_ids].sort((a, b) => a.localeCompare(b)),
        negative_evidence_ids: [...entry.negative_evidence_ids].sort((a, b) => a.localeCompare(b)),
    };
}

export async function buildIndex({ outputPath, inputDir = LINKED_DIR }) {
    const startTime = Date.now();
    console.log('[TARGET-INDEX] V0.6 — building uniprot-keyed inverse index (C2-3)');

    const targets = new Map();
    const compoundToUniprots = new Map();

    const bioStats = await passBioactivities(inputDir, targets, compoundToUniprots);
    console.log(`[TARGET-INDEX]   bioactivities: ${bioStats.processed} processed, ${bioStats.indexed} with uniprot, ${targets.size} unique targets`);
    const trialStats = await passTrials(inputDir, targets, compoundToUniprots);
    console.log(`[TARGET-INDEX]   trials:        ${trialStats.processed} processed, ${trialStats.fannedOut} (trial, target) edges`);
    const negStats = await passNegEvidence(inputDir, targets, compoundToUniprots);
    console.log(`[TARGET-INDEX]   neg-evidence:  ${negStats.processed} processed, ${negStats.fannedOut} (neg, target) edges`);

    // Determinism: sort uniprot keys ascending, then build the output object
    // with insertion order preserved (V8 honors insertion order for non-numeric
    // string keys, so JSON.stringify emits them in this order).
    const sortedKeys = [...targets.keys()].sort((a, b) => a.localeCompare(b));
    const targetsOut = Object.create(null);
    for (const key of sortedKeys) {
        targetsOut[key] = serializeEntry(targets.get(key));
    }

    const index = {
        version: VERSION,
        built_at: new Date().toISOString(),
        targets: targetsOut,
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const serialized = JSON.stringify(index);
    await fs.writeFile(outputPath, serialized, 'utf-8');

    const stat = await fs.stat(outputPath);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[TARGET-INDEX] Done: ${outputPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB) in ${elapsed}s`);
    return {
        targetCount: targets.size,
        bioactivitiesIndexed: bioStats.indexed,
        trialEdges: trialStats.fannedOut,
        negEvidenceEdges: negStats.fannedOut,
        sizeBytes: stat.size,
        elapsedSec: elapsed,
    };
}

async function main() {
    const outputPath = path.join(LINKED_DIR, OUTPUT_FILE);
    await fs.mkdir(LINKED_DIR, { recursive: true });
    await buildIndex({ outputPath });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
    main().catch(err => { console.error('[TARGET-INDEX] Fatal:', err); process.exit(1); });
}

export { OUTPUT_FILE };
