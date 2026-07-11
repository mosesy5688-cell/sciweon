/**
 * RC-3B-P0B -- command-class WRITE-GUARD (the last line of defense).
 *
 * Wraps a real S3/R2 client so EVERY command is inspected BEFORE it reaches the
 * store. Default-deny by command CLASS:
 *   - ALLOWED: ListObjectsV2Command, HeadObjectCommand, GetObjectCommand.
 *   - MUTATION (Put/Delete/Copy/Multipart/...): counted, then THROWN -- never
 *     reaches the network (fail-before-network).
 *   - Anything else: an unknown/unexpected command -- counted, then THROWN.
 * On top of the class check it enforces the EXACT bucket + the EXACT
 * key/prefix allowlist (default-deny). It also refuses ANY command once the
 * Budget is STOPPED, so `network_calls_after_stop` stays 0.
 *
 * The typed read-only client does all semantic pre-network checks and only
 * sends allowlisted commands; this guard exists so that even a caller bug (or a
 * rogue client swapped in) cannot mutate or read outside the allowlist.
 */

export const ALLOWED_COMMANDS = Object.freeze(new Set([
    'ListObjectsV2Command', 'HeadObjectCommand', 'GetObjectCommand',
]));
export const MUTATION_COMMANDS = Object.freeze(new Set([
    'PutObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand',
    'CopyObjectCommand', 'UploadPartCommand', 'UploadPartCopyCommand',
    'CreateMultipartUploadCommand', 'CompleteMultipartUploadCommand',
    'AbortMultipartUploadCommand', 'PutObjectTaggingCommand',
    'PutBucketLifecycleConfigurationCommand', 'RestoreObjectCommand',
]));

/**
 * @param {{send:Function}} realClient
 * @param {{bucket:string, exactKeys:Set<string>, exactPrefixes:Set<string>, budget?:object}} cfg
 */
export function instrumentStructuralReadOnlyClient(realClient, cfg) {
    const bucket = cfg.bucket;
    const exactKeys = cfg.exactKeys instanceof Set ? cfg.exactKeys : new Set(cfg.exactKeys || []);
    const exactPrefixes = cfg.exactPrefixes instanceof Set ? cfg.exactPrefixes : new Set(cfg.exactPrefixes || []);
    const budget = cfg.budget || null;
    const log = [];
    const state = {
        list: 0, head: 0, get: 0, mutation: 0, unexpected: 0,
        nonAllowlisted: 0, outOfBucket: 0, writeAttempt: 0,
        // attemptsAfterStop: sends REFUSED after a STOP (not network calls).
        // networkCallsAfterStop: ACTUAL realClient.send calls after STOP -- 0 by
        // construction (a stopped budget is refused BEFORE realClient.send).
        attemptsAfterStop: 0, networkCallsAfterStop: 0,
    };
    const refuse = (msg) => { throw new Error(`[RC3B COMMAND GUARD] ${msg}`); };

    return {
        sendLog: log,
        get callCount() { return log.length; },
        get list_count() { return state.list; },
        get head_count() { return state.head; },
        get get_count() { return state.get; },
        get mutation_attempt_count() { return state.mutation; },
        get unexpected_command_count() { return state.unexpected; },
        get non_allowlisted_count() { return state.nonAllowlisted; },
        get out_of_bucket_count() { return state.outOfBucket; },
        get attempts_after_stop() { return state.attemptsAfterStop; },
        get network_calls_after_stop() { return state.networkCallsAfterStop; },
        get write_attempt_count() { return state.writeAttempt; },
        async send(command, ...rest) {
            const ctor = command?.constructor?.name ?? 'UnknownCommand';
            const input = command?.input ?? {};

            if (budget && budget.stopped) {
                // A refused post-STOP send is an ATTEMPT, not a network call: we
                // refuse BEFORE realClient.send, so networkCallsAfterStop stays 0.
                state.attemptsAfterStop += 1;
                refuse(`refusing ${ctor} -- the run is STOPPED; no network call after STOP`);
            }
            if (MUTATION_COMMANDS.has(ctor)) {
                state.mutation += 1; state.writeAttempt += 1;
                refuse(`refusing MUTATION command (${ctor}) -- strictly read-only: no Put/Delete/Copy/Multipart`);
            }
            if (!ALLOWED_COMMANDS.has(ctor)) {
                state.unexpected += 1; state.writeAttempt += 1;
                refuse(`refusing UNKNOWN command (${ctor}) -- only ListObjectsV2/HeadObject/GetObject are permitted`);
            }
            if (input.Bucket !== bucket) {
                state.outOfBucket += 1;
                refuse(`refusing ${ctor} for non-allowlisted bucket ${JSON.stringify(input.Bucket)} -- only ${JSON.stringify(bucket)} is permitted`);
            }
            if (ctor === 'ListObjectsV2Command') {
                const prefix = input.Prefix ?? null;
                if (prefix == null || !exactPrefixes.has(prefix)) {
                    state.nonAllowlisted += 1;
                    refuse(`refusing LIST for non-allowlisted prefix ${JSON.stringify(prefix)} -- only exact committed prefixes are permitted (no free-form prefix)`);
                }
                state.list += 1;
            } else {
                const key = input.Key ?? null;
                if (key == null || !exactKeys.has(key)) {
                    state.nonAllowlisted += 1;
                    refuse(`refusing ${ctor} for non-allowlisted key ${JSON.stringify(key)} -- only exact committed keys are permitted`);
                }
                if (ctor === 'HeadObjectCommand') state.head += 1; else state.get += 1;
            }

            const entry = {
                seq: log.length + 1, command: ctor,
                key: input.Key ?? input.Prefix ?? null,
                range: input.Range ?? null,
            };
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
