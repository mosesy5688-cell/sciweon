/**
 * RK-16C FULL-CORPUS SPIKE (M2) — STRICTER-than-P8R1 exact read-only guard.
 *
 * P8R1's instrumentReadOnlyClient ALLOWS ListObjectsV2 (prefix discovery). This
 * spike must NEVER list/discover: it reads ONLY two exact, pre-pinned keys. This
 * guard therefore:
 *   - PERMITS only HeadObjectCommand + GetObjectCommand;
 *   - AND only when command.input.Key is in the EXACT allowlist (default-deny);
 *   - THROWS on ListObjectsV2Command and ANY List/prefix/discovery command;
 *   - THROWS on any non-allowlisted Key (HEAD or GET);
 *   - THROWS on any PUT/DELETE/COPY/multipart;
 *   - THROWS on any latest-alias resolution (snapshots/latest.json is never
 *     allowlisted, so it is rejected as a non-allowlisted key).
 * There is NO fallback to another object. Counters are bumped BEFORE throwing so
 * a post-mortem audit always sees the attempt.
 */

const READ_COMMANDS = new Set(['HeadObjectCommand', 'GetObjectCommand']);
const LIST_COMMANDS = new Set([
    'ListObjectsV2Command', 'ListObjectsCommand', 'ListBucketsCommand',
    'ListMultipartUploadsCommand', 'ListPartsCommand', 'ListObjectVersionsCommand',
]);
const PUT_COMMANDS = new Set([
    'PutObjectCommand', 'CopyObjectCommand', 'UploadPartCommand',
    'UploadPartCopyCommand', 'CreateMultipartUploadCommand', 'CompleteMultipartUploadCommand',
]);
const DELETE_COMMANDS = new Set([
    'DeleteObjectCommand', 'DeleteObjectsCommand', 'AbortMultipartUploadCommand',
]);

/**
 * @param {object} realClient  the underlying S3 client ({ send })
 * @param {Iterable<string>} allowlist  the EXACT object keys permitted
 */
export function instrumentExactReadOnlyClient(realClient, allowlist) {
    const allowed = new Set(allowlist);
    const log = [];
    const state = {
        put: 0, delete: 0, list: 0, writeAttempt: 0,
        nonAllowlistedKeyAttempt: 0, listAttempt: 0, head: 0, get: 0,
    };
    const refuse = (msg) => { throw new Error(`[RK16C EXACT READ-ONLY GUARD] ${msg}`); };

    return {
        sendLog: log,
        allowlist: [...allowed],
        get callCount() { return log.length; },
        get put_count() { return state.put; },
        get delete_count() { return state.delete; },
        get list_count() { return state.list; },
        get write_attempt_count() { return state.writeAttempt; },
        get list_attempt_count() { return state.listAttempt; },
        get non_allowlisted_key_attempt_count() { return state.nonAllowlistedKeyAttempt; },
        get readCounts() { return { list: state.list, head: state.head, get: state.get }; },
        async send(command, ...rest) {
            const ctorName = command?.constructor?.name ?? 'UnknownCommand';

            if (LIST_COMMANDS.has(ctorName)) {
                state.listAttempt += 1;
                state.writeAttempt += 0; // list is not a write, but it IS forbidden
                refuse(`refusing a LIST/discovery command (${ctorName}) — this spike reads ONLY exact pre-pinned keys; no List/prefix/discovery is permitted`);
            }
            if (PUT_COMMANDS.has(ctorName)) {
                state.put += 1; state.writeAttempt += 1;
                refuse(`refusing a write command (${ctorName}) — strictly read-only: no Put/Copy/Multipart`);
            }
            if (DELETE_COMMANDS.has(ctorName)) {
                state.delete += 1; state.writeAttempt += 1;
                refuse(`refusing a delete command (${ctorName}) — strictly read-only: no Delete/Abort`);
            }
            if (!READ_COMMANDS.has(ctorName)) {
                state.writeAttempt += 1;
                refuse(`refusing an unrecognized command (${ctorName}) — only HeadObject/GetObject of allowlisted keys are permitted`);
            }

            // Read command: enforce EXACT allowlist (default-deny). No prefix, no fallback.
            const key = command?.input?.Key ?? null;
            if (key == null || !allowed.has(key)) {
                state.nonAllowlistedKeyAttempt += 1;
                refuse(`refusing ${ctorName} for non-allowlisted key ${JSON.stringify(key)} — only the exact pinned keys [${[...allowed].join(', ')}] are permitted; no latest resolution, no fallback`);
            }

            if (ctorName === 'HeadObjectCommand') state.head += 1;
            else state.get += 1;
            const entry = { seq: log.length + 1, command: ctorName, key };
            log.push(entry);
            try {
                const res = await realClient.send(command, ...rest);
                entry.ok = true;
                return res;
            } catch (err) {
                entry.ok = false;
                entry.errorName = err?.name ?? null;
                throw err;
            }
        },
    };
}
