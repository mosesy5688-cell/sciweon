/**
 * RC-3B-P0B -- minimal READ-ONLY S3/R2 client construction.
 *
 * Deliberately does NOT import scripts/factory/lib/r2-helpers.js (the producer
 * client that carries PutObject / DeleteObjects / Multipart). It constructs an
 * S3Client DIRECTLY and this module imports ONLY the S3Client constructor --
 * never a mutation command class. Combined with the command guard (which
 * default-denies every non-read command) the resulting client can only ever
 * issue List/Head/Get of allowlisted objects.
 *
 * Returns null when credentials are absent, so the harness fails-closed / inert
 * with no environment provisioned (it never fabricates or requests a token).
 */

import { S3Client } from '@aws-sdk/client-s3';

/**
 * @param {object} env  defaults to process.env; injected in tests
 * @returns {S3Client|null} null when required read-only creds are missing
 */
export function makeMinimalReadOnlyS3Client(env = process.env) {
    const accountId = env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID;
    const accessKeyId = env.R2_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
        return null;
    }
    return new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
    });
}
