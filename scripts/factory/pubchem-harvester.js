/**
 * PubChem Harvester V0.1a — small-scale validation run.
 *
 * Goal: prove schema + validation gate + adapter end-to-end with 1000 compounds.
 *
 * Usage:
 *   node scripts/factory/pubchem-harvester.js [--limit=1000] [--start-cid=1]
 *
 * Output: output/compounds/*.jsonl (one entity per line, for inspection)
 */

import fs from 'fs/promises';
import path from 'path';
import { getCompound } from '../ingestion/adapters/pubchem-adapter.js';
import { COMPOUND_SCHEMA } from '../../src/lib/schemas/compound.js';
import { gate, MODE_WARN } from './lib/validation-gate.js';

const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '1000');
const START_CID = parseInt(process.argv.find(a => a.startsWith('--start-cid='))?.split('=')[1] || '1');
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output/compounds';
const BATCH_DELAY_MS = 250; // 4 req/sec safety margin (PubChem limit is 5/sec)

async function main() {
    console.log(`[HARVESTER] V0.1a small-scale run — limit=${LIMIT}, start_cid=${START_CID}`);
    console.log(`[HARVESTER] Validation mode: WARN (log violations, accept data)`);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    let fetched = 0, valid = 0, warned = 0;
    const entities = [];
    const violationsLog = [];

    for (let cid = START_CID; cid < START_CID + LIMIT; cid++) {
        const entity = await getCompound(cid);
        fetched++;
        if (!entity) { await sleep(BATCH_DELAY_MS); continue; }

        const result = gate(entity, COMPOUND_SCHEMA, `CID:${cid}`);
        if (result.passed) {
            entities.push(entity);
            valid++;
            if (result.warnings) {
                warned++;
                violationsLog.push({ cid, warnings: result.warnings });
            }
        }

        if (fetched % 50 === 0) {
            console.log(`[HARVESTER] Progress: ${fetched} fetched | ${valid} valid | ${warned} warned`);
        }
        await sleep(BATCH_DELAY_MS);
    }

    const outputFile = path.join(OUTPUT_DIR, `compounds-cid-${START_CID}-${START_CID + LIMIT - 1}.jsonl`);
    await fs.writeFile(outputFile, entities.map(e => JSON.stringify(e)).join('\n'));
    if (violationsLog.length > 0) {
        const violationsFile = path.join(OUTPUT_DIR, `violations-cid-${START_CID}-${START_CID + LIMIT - 1}.json`);
        await fs.writeFile(violationsFile, JSON.stringify(violationsLog, null, 2));
        console.log(`[HARVESTER] ⚠️ ${violationsLog.length} entities had warnings (saved to ${violationsFile})`);
    }

    console.log(`[HARVESTER] ✅ Complete: ${fetched} attempted | ${valid} valid | ${warned} warned`);
    console.log(`[HARVESTER] Output: ${outputFile} (${entities.length} entities)`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(err => { console.error('[HARVESTER] Fatal:', err); process.exit(1); });
