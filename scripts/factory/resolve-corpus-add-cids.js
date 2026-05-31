/**
 * PR-MD-2b: resolve the corpus add-list UNIIs -> PubChem CIDs (the addressability
 * gate). Reads state/dailymed-corpus-add-list.json (the 2a artifact), inverts the
 * FDA SRS InChIKey index to UNII-keyed, resolves UNII -> InChIKey -> CID via UniChem,
 * and emits state/dailymed-corpus-add-cids.json for USER REVIEW before PR-MD-2c.
 *
 * Diagnostic-only: no compound fetch, no corpus mutation. All testable logic lives in
 * lib/corpus-add-cids-resolve.js; this is the thin R2/UniChem I/O orchestration.
 *
 * Usage: node resolve-corpus-add-cids.js  (R2 env required; UniChem is public)
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { loadLookupFromR2 } from '../ingestion/adapters/fda-srs-adapter.js';
import { fetchByInchiKey, REQUEST_DELAY_MS } from '../ingestion/adapters/unichem-adapter.js';
import {
    invertSrsToUniiIndex, classifyUniiResolution, buildAddCidsArtifact,
} from './lib/corpus-add-cids-resolve.js';

const ADD_LIST_KEY = 'state/dailymed-corpus-add-list.json';
const OUT_KEY = 'state/dailymed-corpus-add-cids.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeR2Client() {
    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length > 0) throw new Error(`R2 env not configured (missing: ${missing.join(', ')})`);
    return new S3Client({
        endpoint: process.env.R2_ENDPOINT,
        region: 'auto',
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
    });
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function main() {
    console.log('[CORPUS-ADD-CIDS] PR-MD-2b -- resolve add-list UNIIs -> CIDs (addressability gate)');
    const client = makeR2Client();
    const bucket = process.env.R2_BUCKET;

    const addRes = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ADD_LIST_KEY }));
    const addList = JSON.parse((await streamToBuffer(addRes.Body)).toString('utf-8'));
    const targetUniis = Array.isArray(addList.target_uniis) ? addList.target_uniis : [];
    console.log(`[CORPUS-ADD-CIDS] add-list: ${targetUniis.length} target UNIIs (corpus_fixable=${addList.corpus_fixable_labels})`);
    if (targetUniis.length === 0) { console.error('[CORPUS-ADD-CIDS] empty target_uniis - nothing to resolve.'); process.exit(1); }

    const { map } = await loadLookupFromR2();
    const uniiIndex = invertSrsToUniiIndex(map);
    console.log(`[CORPUS-ADD-CIDS] SRS UNII-first index: ${uniiIndex.size} UNIIs`);

    const classified = [];
    let i = 0;
    for (const u of targetUniis) {
        const hit = uniiIndex.get(u);
        if (!hit) { classified.push(classifyUniiResolution(u, null, null)); continue; }
        let cid = null;
        try {
            const res = await fetchByInchiKey(hit.inchi_key);
            cid = res?.pubchem_cid ?? null;
        } catch (err) {
            console.warn(`[CORPUS-ADD-CIDS] UniChem ${u}/${hit.inchi_key}: ${err.message}`);
        }
        classified.push(classifyUniiResolution(u, hit.inchi_key, cid, hit.name));
        if (++i % 25 === 0) console.log(`[CORPUS-ADD-CIDS] resolved ${i}/${targetUniis.length}`);
        await sleep(REQUEST_DELAY_MS);
    }

    const artifact = buildAddCidsArtifact(classified);
    artifact.generated_from = process.env.GITHUB_RUN_ID ?? null;
    const c = artifact.coverage;
    console.log(`[CORPUS-ADD-CIDS] coverage: target=${c.target} resolvable=${c.resolvable_n} unresolvable=${c.unresolvable_n} by_reason=${JSON.stringify(c.by_reason)}`);

    try {
        await client.send(new PutObjectCommand({
            Bucket: bucket, Key: OUT_KEY,
            Body: JSON.stringify(artifact, null, 2),
            ContentType: 'application/json',
        }));
        console.log(`[CORPUS-ADD-CIDS] emitted ${OUT_KEY}`);
    } catch (err) {
        console.error(`[CORPUS-ADD-CIDS] emit failed: ${err.message}`);
        process.exit(1);
    }
}

main().catch((err) => { console.error('[CORPUS-ADD-CIDS] FATAL:', err.message); process.exit(2); });
