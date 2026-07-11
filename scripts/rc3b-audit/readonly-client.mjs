/**
 * RC-3B-P0B -- the dedicated READ-ONLY R2 client (typed methods ONLY).
 *
 * Exposes EXACTLY four typed methods and NOTHING generic:
 *   listExactPrefix(prefix)              -- ListObjectsV2 over an EXACT prefix
 *   headExactKey(key)                    -- HeadObject of an EXACT key
 *   getStructuralMetadata(key)           -- structural GET-META (no Range),
 *                                           ONLY after HEAD proves small enough
 *   readLocatorBoundRange(key,off,len)   -- Range GET of an NXVF locator target
 *
 * There is NO send(command) / request(method,key) / getObject(key). Every
 * method does all pre-network checks (allowlist, placeholder, format, caps)
 * and reserves budget BEFORE constructing a command; the command then passes
 * through the command guard (last-line default-deny). This module imports ONLY
 * the three read command classes -- never a mutation command, never the
 * producer r2-helpers client.
 */

import { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { instrumentStructuralReadOnlyClient } from './command-guard.mjs';
import { findPlaceholder } from './placeholder-scan.mjs';
import { classifyRangeTarget, inferClassFromKey, isPayloadClass } from './format-policy.mjs';
import { streamToBuffer, structuralFacts, sampleFacts } from './shape-facts.mjs';

function targetKeyOf(t) { return `${t.key}|${t.offset}|${t.length}`; }

export function makeReadOnlyR2Client(rawClient, plan, budget) {
    const bucket = plan.bucket;
    const exactPrefixes = new Set(plan.exact_prefixes || []);
    const structuralKeys = new Set(plan.structural_keys || []);
    const headKeys = new Set(plan.class_c_head_keys || []);
    const rangeTargets = new Map((plan.class_x_targets || []).map((t) => [targetKeyOf(t), t]));
    const rangeKeys = new Set((plan.class_x_targets || []).map((t) => t.key));
    const classMap = plan.object_class_map || {};
    const exactKeys = new Set([...structuralKeys, ...headKeys, ...rangeKeys]);

    const guarded = instrumentStructuralReadOnlyClient(rawClient, {
        bucket, exactKeys, exactPrefixes, budget,
    });

    const classOf = (key) => classMap[key] || inferClassFromKey(key);
    const noPlaceholder = (val, code) => {
        const tok = findPlaceholder(val);
        if (tok) budget.reject('UNRESOLVED_PLACEHOLDER', `unresolved placeholder ${JSON.stringify(tok)} in ${JSON.stringify(val)} -- ${code}`);
    };

    async function listExactPrefix(prefix) {
        if (!exactPrefixes.has(prefix)) {
            budget.reject('OUT_OF_ALLOWLIST', `prefix ${JSON.stringify(prefix)} is not an exact committed prefix`);
        }
        noPlaceholder(prefix, 'list prefix');
        const keys = [];
        let token; let pages = 0; let stoppedByCap = false;
        do {
            budget.reserveListPage();
            pages += 1;
            const r = await guarded.send(new ListObjectsV2Command({
                Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token,
            }));
            const contents = r.Contents || [];
            for (const o of contents) keys.push({ key: o.Key, size: o.Size ?? 0, etag: o.ETag ?? null });
            budget.addListKeys(contents.length);
            if (budget.stopped) { stoppedByCap = true; break; }
            token = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (token);
        return { prefix, keys, pages, stoppedByCap };
    }

    async function headExactKey(key) {
        if (!exactKeys.has(key)) {
            budget.reject('OUT_OF_ALLOWLIST', `key ${JSON.stringify(key)} is not an exact committed key`);
        }
        noPlaceholder(key, 'head key');
        budget.reserveHead();
        budget.touchObject(key);
        const r = await guarded.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { key, etag: r.ETag ?? null, content_length: r.ContentLength ?? 0 };
    }

    async function getStructuralMetadata(key) {
        if (!structuralKeys.has(key)) {
            budget.reject('OUT_OF_ALLOWLIST', `key ${JSON.stringify(key)} is not an exact structural key`);
        }
        noPlaceholder(key, 'structural key');
        const cls = classOf(key);
        if (isPayloadClass(cls)) {
            budget.reject('FORMAT_NOT_SEEKABLE', `payload-class key ${JSON.stringify(key)} (${cls}) has no Range -- a no-Range GET on payload is forbidden`);
        }
        // HEAD first so we know the size BEFORE any body GET.
        budget.reserveHead();
        budget.touchObject(key);
        const head = await guarded.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const size = head.ContentLength ?? 0;
        // Rejects (before body GET) if the object is larger than the GET-META cap.
        budget.reserveGetMeta(size);
        const got = await guarded.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const buf = await streamToBuffer(got.Body);
        return { key, object_class: cls, etag: got.ETag ?? head.ETag ?? null, ...structuralFacts(buf) };
    }

    async function readLocatorBoundRange(key, offset, length) {
        const target = rangeTargets.get(`${key}|${offset}|${length}`);
        if (!target) {
            budget.reject('OUT_OF_ALLOWLIST', `range target ${key}[${offset},+${length}] is not an exact committed class-X target`);
        }
        noPlaceholder(key, 'range key');
        const declared = target.object_class || classOf(key);
        const verdict = classifyRangeTarget(key, declared);
        if (!verdict.ok) {
            budget.reject('FORMAT_NOT_SEEKABLE', `range refused for ${JSON.stringify(key)}: ${verdict.reason}`);
        }
        budget.reserveRange(length); // rejects oversize single range; stops on cap
        budget.touchObject(key);
        const end = offset + length - 1;
        const got = await guarded.send(new GetObjectCommand({
            Bucket: bucket, Key: key, Range: `bytes=${offset}-${end}`,
        }));
        const buf = await streamToBuffer(got.Body);
        return {
            key, offset, length, object_class: verdict.effectiveClass, etag: got.ETag ?? null,
            ...sampleFacts(buf, budget.caps.MAX_DECODED_BYTES_PER_SAMPLE),
        };
    }

    // Read-only COUNTERS snapshot (NOT the guard itself -- no send is exposed).
    const guardCounters = () => ({
        network_calls_after_stop: guarded.network_calls_after_stop,
        unexpected_command_count: guarded.unexpected_command_count,
        mutation_attempt_count: guarded.mutation_attempt_count,
        non_allowlisted_count: guarded.non_allowlisted_count,
        out_of_bucket_count: guarded.out_of_bucket_count,
        write_attempt_count: guarded.write_attempt_count,
        list_count: guarded.list_count,
        head_count: guarded.head_count,
        get_count: guarded.get_count,
        call_count: guarded.callCount,
    });

    // EXACTLY the four typed methods (+ a counters snapshot). No generic
    // send(command) / request(method,key) / getObject(key) is exposed.
    return {
        bucket,
        listExactPrefix,
        headExactKey,
        getStructuralMetadata,
        readLocatorBoundRange,
        guardCounters,
    };
}
