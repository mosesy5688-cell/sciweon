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
import { normalizeAccountId } from './endpoint-binding.mjs';

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
    // C4-A / B2: build the endpoint from the account id under the SAME normalization
    // (normalizeAccountId) that deriveEndpointBinding uses, so the client's account
    // is byte-for-byte the SAME value that assertEndpointBinding already verified
    // against the authorized plan binding. The raw account id / endpoint are never
    // logged or returned (crypto/transport only); no new command class is added.
    return new S3Client({
        region: 'auto',
        endpoint: `https://${normalizeAccountId(accountId)}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
    });
}
