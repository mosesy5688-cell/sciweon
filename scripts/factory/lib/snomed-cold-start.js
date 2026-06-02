/**
 * SNOMED cold-start discriminator -- PR-UMLS-3 cold-start guard.
 *
 * PR-UMLS-3 wires a NEW SNOMED sub-pipeline (linker -> 1.9 stamp -> public-builder ->
 * crosslink) into the production daily F-cascade. But the SNOMED harvest is NEW in the
 * same PR, so at merge time the R2 artifacts do NOT exist yet (the first harvest has not
 * run). The cursor key `state/umls-snomed-bulk-cursor.json` is the AUTHORITATIVE
 * cold-start discriminator (it is written ONLY by a successful harvest):
 *
 *   INVARIANT 1 -- cursor MISSING (NoSuchKey / 404) = cold start = GRACEFUL SKIP.
 *     The whole SNOMED sub-pipeline (all 4 stages) is excluded for this cycle so the
 *     snapshot still publishes (without SNOMED data). A LOUD multi-line warning banner
 *     is emitted so the skip is never silent.
 *
 *   INVARIANT 2 -- cursor EXISTS but the downstream artifact read fails (missing data
 *     file, zstd-decompress failure, byte/record-count mismatch, JSON parse degradation)
 *     = NORMAL operation incremental-data miss = HARD FAIL in place (the existing throw
 *     behavior in each stage is preserved). This module does NOT touch that path.
 *
 * The discriminator is CURSOR EXISTENCE (a single R2 HEAD), determined ONCE and threaded
 * so all 4 stages honor it consistently -- one stage must never skip while another throws.
 */

import { HeadObjectCommand } from '@aws-sdk/client-s3';

export const SNOMED_CURSOR_KEY = 'state/umls-snomed-bulk-cursor.json';

/**
 * Authoritative cold-start probe: HEAD the SNOMED bulk cursor key.
 * @returns {Promise<boolean>} true IFF the cursor physically does NOT exist (404 / NoSuchKey).
 *   Any OTHER error (auth, network, 5xx) is RETHROWN -- a transient R2 failure must NOT be
 *   mis-read as cold start (that would skip SNOMED on a normal cycle, a silent data loss).
 */
export async function isSnomedColdStart({ client, bucket }) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: SNOMED_CURSOR_KEY }));
        return false; // cursor exists -> NOT cold start (broken-artifact path hard-fails downstream)
    } catch (err) {
        if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return true; // cursor absent -> cold start
        }
        throw err; // any other error is NOT a cold-start signal
    }
}

/** Emit the LOUD multi-line cold-start warning banner (so the graceful skip is never silent). */
export function warnSnomedColdStart() {
    console.warn('============= [CRITICAL LAUNCH WARNING] =============');
    console.warn('SNOMED CT initial harvest data not yet materialized in R2.');
    console.warn('Skipping SNOMED sub-pipeline (linker, 1.9 stamp, public-builder, crosslink) for this cycle.');
    console.warn('=====================================================');
}

/** Cascade entries (stamper + post-stamp UMLS phases) that belong to the SNOMED sub-pipeline. */
export const SNOMED_CASCADE_SCRIPTS = Object.freeze([
    'stage-3-snomed-sid-stamp.js',
    'snomed-public-builder.js',
    'snomed-crosslink-enricher.js',
]);
