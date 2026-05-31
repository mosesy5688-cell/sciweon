/**
 * PR-MD-2a: build + emit the DailyMed corpus add-list (the surgical "what to add"
 * SSoT). The not_in_corpus rxcui each carry a UNII that NO corpus compound holds;
 * adding those compounds lets the existing bulk pre-pass auto-stamp rxcui and the
 * DailyMed relink auto-link drug_labels. This artifact is the FULL enumerated target
 * set (NOT Top-N, per triple-lock) consumed by PR-MD-2b (UNII -> CID resolution).
 *
 * HONEST CAVEAT (slice_not_world): this is the HARM-side target (zero-productive
 * labels' missing UNIIs). The ADDRESSABLE subset (UNII -> in-scope small-molecule
 * CID) is <= this set and is measured in PR-MD-2b, then further attrited at 2c's
 * scope gate. The artifact never claims these are all addable.
 *
 * buildCorpusAddList is pure (testable). emitCorpusAddList is env-gated + non-fatal
 * R2 I/O (mirrors source-completeness.js), so local/test F3 runs degrade cleanly.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const STATE_KEY = 'state/dailymed-corpus-add-list.json';
const REQUIRED_ENV = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

/**
 * Pure: build the add-list artifact from a relinkCumulativeDailymed result.
 * @param {object} rl  { buckets: { not_in_corpus_full: [{rxcui,uniis[]}] }, labelProductivity: { corpus_fixable } }
 */
export function buildCorpusAddList(rl) {
    const full = Array.isArray(rl?.buckets?.not_in_corpus_full) ? rl.buckets.not_in_corpus_full : [];
    const uniiSet = new Set();
    for (const e of full) for (const u of (e?.uniis ?? [])) if (typeof u === 'string' && u) uniiSet.add(u);
    return {
        schema_version: 1,
        note: 'HARM-side target (not_in_corpus rxcui UNIIs). Addressability (UNII->CID) is measured in PR-MD-2b and is <= this set; do not assume these are all addable.',
        target_rxcui_count: full.length,
        target_uniis: [...uniiSet].sort(),
        corpus_fixable_labels: rl?.labelProductivity?.corpus_fixable ?? null,
        not_in_corpus: full,
    };
}

/**
 * Env-gated, non-fatal R2 emit of the artifact to state/dailymed-corpus-add-list.json.
 * Returns true on success, false if skipped (no env) or failed (logged, never throws).
 */
export async function emitCorpusAddList(artifact, { generatedFrom = null } = {}) {
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length > 0) {
        console.warn(`[CORPUS-ADD-LIST] R2 env missing (${missing.join(',')}) - emit skipped`);
        return false;
    }
    const body = { generated_from: generatedFrom, ...artifact };
    try {
        const client = new S3Client({
            endpoint: process.env.R2_ENDPOINT,
            region: 'auto',
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });
        await client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: STATE_KEY,
            Body: JSON.stringify(body, null, 2),
            ContentType: 'application/json',
        }));
        console.log(`[CORPUS-ADD-LIST] emitted ${STATE_KEY}: ${artifact.target_rxcui_count} rxcui / ${artifact.target_uniis.length} uniis / corpus_fixable=${artifact.corpus_fixable_labels}`);
        return true;
    } catch (err) {
        console.error(`[CORPUS-ADD-LIST] emit failed (non-fatal): ${err.message}`);
        return false;
    }
}
