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
 * Returns null when NOTHING is provisioned, so the harness fails-closed / inert
 * with no environment provisioned (it never fabricates or requests a token).
 *
 * C4-E-T1: a complete long-term trio is NOT sufficient. When the trio is present
 * the run additionally REQUIRES a temporary R2 session token (Cloudflare temp
 * credentials), consumed as the AWS `sessionToken`. There is NO fallback to a
 * 3-field-only credential: a missing/invalid session token fails-loud (fixed,
 * leak-free code) before any client is built.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { normalizeAccountId } from './endpoint-binding.mjs';
import { assertValidSessionToken, SESSION_TOKEN_ENV } from './session-token.mjs';

/**
 * @param {object} env  defaults to process.env; injected in tests
 * @returns {S3Client|null} null ONLY when nothing at all is provisioned
 * @throws {Error} `[RC3B CRED] CREDENTIAL_INCOMPLETE` on a partial trio;
 *                 `[RC3B CRED] SESSION_TOKEN_INVALID: ...` on a missing/invalid
 *                 temporary session token (no fallback). No secret bytes leak.
 */
export function makeMinimalReadOnlyS3Client(env = process.env) {
    const accountId = env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID;
    const accessKeyId = env.R2_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
    const rawSession = env[SESSION_TOKEN_ENV];
    const sessionTokenPresent = typeof rawSession === 'string' && rawSession.trim() !== '';

    // Fully-inert path: accountId AND accessKeyId AND secretAccessKey AND the
    // session-token env are ALL absent -> nothing provisioned -> return null; the
    // harness stays inert with no client, exactly as before.
    if (!accountId && !accessKeyId && !secretAccessKey && !sessionTokenPresent) {
        return null;
    }
    // Any credential material present but the long-term trio is incomplete -> fail
    // loud (no partial client, no token bytes). A session-token-only env also has
    // an incomplete trio and is rejected here.
    if (!accountId || !accessKeyId || !secretAccessKey) {
        throw new Error('[RC3B CRED] CREDENTIAL_INCOMPLETE');
    }
    // Trio complete -> a temporary R2 session token is REQUIRED (NO fallback to a
    // long-term 3-field credential). assertValidSessionToken throws a fixed,
    // leak-free code on a missing/invalid token, so a 3-field-only credential can
    // never build a client.
    const sessionToken = assertValidSessionToken(env);
    // C4-A / B2: build the endpoint from the account id under the SAME normalization
    // (normalizeAccountId) that deriveEndpointBinding uses, so the client's account
    // is byte-for-byte the SAME value that assertEndpointBinding already verified
    // against the authorized plan binding. The raw account id / keys / session token
    // / endpoint are never logged or returned (crypto/transport only); no new
    // command class is added.
    return new S3Client({
        region: 'auto',
        endpoint: `https://${normalizeAccountId(accountId)}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey, sessionToken },
    });
}
