/**
 * PR-MD-2c: corpus add-list MUTATION -- seed the resolvable add-cids into the
 * corpus (the FIRST real corpus mutation of the DailyMed cross-link arc).
 *
 * Mirrors stage-1-strategic-harvest.js (harvester RETRY_CIDS -> cross-source-linker
 * -> baseline upload -> F2/F3 cascade), with two differences:
 *   - SEED from R2 state/dailymed-corpus-add-cids.json (resolvable[]), NOT a
 *     hand-committed list (no manual-list drift).
 *   - INJECT external_ids.unii = u on each linked baseline compound (Collar A;
 *     safe because every downstream unii-writer is first-wins -- see
 *     lib/corpus-add-inject.js header). This makes the bulk rxnorm pre-pass stamp
 *     the target rxcui, and relink attach drug_labels, on the next F3.
 *
 * Collar B: added_n (survived harvest + scope gate, got u) vs resolvable_n; missing
 * CIDs (harvester-dropped macromolecule/no-record) are reported, never silently lost.
 *
 * Usage: node seed-corpus-add-compounds.js  (R2 env required; PubChem public)
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { once } from 'events';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { uploadStage, uploadRaw, deriveRunId, verifyNonEmpty } from './lib/r2-stage-bridge.js';
import { injectUniiAndAccount } from './lib/corpus-add-inject.js';

const ADD_CIDS_KEY = 'state/dailymed-corpus-add-cids.json';
const SCRIPT_DIR = 'scripts/factory';
const RAW_FILE = './output/compounds/compounds-cid-1-0.jsonl';
const ENRICHED_FILE = './output/linked/compounds-enriched.jsonl';
const BASELINE_FILES = ['compounds-enriched.jsonl', 'bioactivities.jsonl'];
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

function makeR2Client() {
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length > 0) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT, region: 'auto',
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function runScript(name, args = [], extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [path.join(SCRIPT_DIR, name), ...args], {
            stdio: 'inherit', env: { ...process.env, ...extraEnv },
        });
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exit ${code}`))));
        child.on('error', reject);
    });
}

async function loadJsonl(file) {
    const c = await fs.readFile(file, 'utf-8');
    return c.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function writeJsonl(file, records) {
    const stream = createWriteStream(file, { encoding: 'utf-8' });
    for (const r of records) { if (!stream.write(JSON.stringify(r) + '\n')) await once(stream, 'drain'); }
    stream.end();
    await once(stream, 'finish');
}

async function loadResolvable(client, bucket) {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ADD_CIDS_KEY }));
    const art = JSON.parse((await streamToBuffer(res.Body)).toString('utf-8'));
    const cidUniiMap = new Map();
    for (const e of (Array.isArray(art.resolvable) ? art.resolvable : [])) {
        const cid = Number(e?.cid);
        if (Number.isInteger(cid) && cid > 0 && typeof e?.unii === 'string' && e.unii) cidUniiMap.set(String(cid), e.unii);
    }
    return cidUniiMap;
}

async function main() {
    const runId = `corpus-add-${deriveRunId()}`;
    console.log(`[CORPUS-ADD-SEED] PR-MD-2c MUTATION run_id=${runId}`);
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    const cidUniiMap = await loadResolvable(client, bucket);
    const cids = [...cidUniiMap.keys()];
    console.log(`[CORPUS-ADD-SEED] resolvable seed: ${cids.length} {cid,unii} from ${ADD_CIDS_KEY}`);
    if (cids.length === 0) { console.error('[CORPUS-ADD-SEED] no resolvable CIDs - nothing to do.'); process.exit(5); }

    console.log('[CORPUS-ADD-SEED] === pubchem-harvester (RETRY_CIDS, scope-gated) ===');
    await runScript('pubchem-harvester.js', ['--start-cid=1', '--limit=0'], { RETRY_CIDS: cids.join(',') });
    await verifyNonEmpty(RAW_FILE);

    console.log('[CORPUS-ADD-SEED] === cross-source-linker (raw -> baseline) ===');
    await runScript('cross-source-linker.js', [`--input=${RAW_FILE}`, `--limit=${cids.length}`]);
    await verifyNonEmpty(ENRICHED_FILE);  // bioactivities may be legitimately empty for substances

    // Inject the target UNII (Collar A) + Collar B accounting.
    const records = await loadJsonl(ENRICHED_FILE);
    const acct = injectUniiAndAccount(records, cidUniiMap);
    await writeJsonl(ENRICHED_FILE, records);
    console.log(`[CORPUS-ADD-SEED] inject: added_n=${acct.added_n} resolvable_n=${acct.resolvable_n} missing=${acct.missing_cids.length} (harvester-dropped: macromolecule/no-record; see harvester log) missing_cids=${JSON.stringify(acct.missing_cids.slice(0, 30))}`);
    if (acct.added_n === 0) { console.error('[CORPUS-ADD-SEED] added_n=0 - no compounds to publish.'); process.exit(3); }

    console.log('[CORPUS-ADD-SEED] === upload baseline -> cascade ===');
    await uploadRaw('pubchem/corpus-add', runId, [[RAW_FILE, path.basename(RAW_FILE)]]);
    await uploadStage('baseline', runId, BASELINE_FILES);
    console.log(`[CORPUS-ADD-SEED] DONE added_n=${acct.added_n}/${acct.resolvable_n} -> processed/baseline/${runId}/ (F2/F3 cascade will stamp rxcui + link drug_labels)`);
    process.exit(0);
}

main().catch((err) => { console.error('[CORPUS-ADD-SEED] FATAL:', err.message); process.exit(2); });
