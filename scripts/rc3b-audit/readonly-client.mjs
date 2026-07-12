/**
 * RC-3B-P0B -- the dedicated READ-ONLY R2 client (typed methods ONLY).
 *
 * Exposes EXACTLY five typed methods and NOTHING generic:
 *   listExactPrefix(prefix)              -- ListObjectsV2 over an EXACT prefix
 *   headExactKey(key)                    -- HeadObject of an EXACT key
 *   getStructuralMetadata(key)           -- structural GET-META (no Range),
 *                                           ONLY after HEAD proves small enough
 *   getLocatorScalars(key)               -- committed structural scalars from
 *                                           one same-buffer bounded GET
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
import { classifyRangeTarget, classifyStructuralTarget, inferClassFromKey, isPayloadClass } from './format-policy.mjs';
import { matchFamily } from './template-policy.mjs';
import { decideOperation } from './operation-matrix.mjs';
import { collectBounded, ResponseBoundExceeded, verifyContentRange } from './bounded-collector.mjs';
import { structuralFacts, sampleFacts } from './shape-facts.mjs';
import { extractLocators } from './locator-extract.mjs';
import { verifySourceBinding } from './locator-source-binding.mjs';

function targetKeyOf(t) { return `${t.key}|${t.offset}|${t.length}`; }

/**
 * @param {object} rawClient   an S3/R2 client with .send (or a fake in tests)
 * @param {object} plan        the validated run manifest
 * @param {object} budget      the per-run Budget
 * @param {object|null} templatePolicy  the committed template policy (harness
 *   passes the loaded policy). When null, the template-family GET-META check is
 *   SKIPPED, but the declared/suffix anti-spoof cross-check is ALWAYS enforced.
 */
export function makeReadOnlyR2Client(rawClient, plan, budget, templatePolicy = null) {
    const bucket = plan.bucket;
    const exactPrefixes = new Set(plan.exact_prefixes || []);
    const structuralKeys = new Set(plan.structural_keys || []);
    const locatorSpecsByKey = new Map();
    for (const spec of plan.structural_locator_specs || []) {
        if (!locatorSpecsByKey.has(spec.key)) locatorSpecsByKey.set(spec.key, []);
        locatorSpecsByKey.get(spec.key).push(spec);
    }
    const locatorKeys = new Set(locatorSpecsByKey.keys());
    const headKeys = new Set(plan.class_c_head_keys || []);
    const rangeTargets = new Map((plan.class_x_targets || []).map((t) => [targetKeyOf(t), t]));
    const rangeKeys = new Set((plan.class_x_targets || []).map((t) => t.key));
    const classMap = plan.object_class_map || {};
    const exactKeys = new Set([...structuralKeys, ...locatorKeys, ...headKeys, ...rangeKeys]);

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
            // Enforce the EXACT remaining LIST-key budget BEFORE any network: if
            // no key budget remains, STOP without sending; clamp MaxKeys to it.
            const remaining = budget.remainingListKeys();
            if (remaining <= 0) { budget.stop('CAP_REACHED'); stoppedByCap = true; break; }
            budget.reserveListPage();
            pages += 1;
            const maxKeys = Math.min(1000, remaining);
            const r = await guarded.send(new ListObjectsV2Command({
                Bucket: bucket, Prefix: prefix, MaxKeys: maxKeys, ContinuationToken: token,
            }));
            const contents = r.Contents || [];
            if (contents.length > maxKeys) {
                // Provider returned MORE than requested: integrity anomaly. STOP
                // and emit NONE of these keys.
                budget.reject('INTEGRITY_ANOMALY', `LIST returned more keys (${contents.length}) than requested MaxKeys (${maxKeys})`);
            }
            const emitted = contents.slice(0, remaining); // never beyond remaining
            for (const o of emitted) keys.push({ key: o.Key, size: o.Size ?? 0, etag: o.ETag ?? null });
            budget.addListKeys(emitted.length);
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
        // CHANGE D: the effective class is SUFFIX-derived (never a free
        // object_class_map override). Consult the operation/class matrix, then
        // require an EXACT CLASS-C HEAD family carrying an explicit matching
        // object_class -- so a payload key can be HEAD-ed ONLY via that family.
        const eff = inferClassFromKey(key);
        const decision = decideOperation({ operation: 'HEAD', effectiveClass: eff });
        if (!decision.allow) {
            budget.reject('FORMAT_NOT_SEEKABLE', `HEAD refused for ${JSON.stringify(key)}: ${decision.reason}`);
        }
        if (templatePolicy) {
            const fam = matchFamily(templatePolicy, { operation: 'HEAD', key, effectiveClass: eff });
            if (!fam) {
                budget.reject('FORMAT_NOT_SEEKABLE', `HEAD key ${JSON.stringify(key)} is not an exact CLASS-C HEAD family instantiation (explicit object_class ${eff})`);
            }
        }
        budget.reserveHead();
        budget.reserveObject(key);
        const r = await guarded.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { key, etag: r.ETag ?? null, content_length: r.ContentLength ?? 0 };
    }

    async function getStructuralMetadata(key) {
        if (!structuralKeys.has(key)) {
            budget.reject('OUT_OF_ALLOWLIST', `key ${JSON.stringify(key)} is not an exact structural key`);
        }
        noPlaceholder(key, 'structural key');
        const declaredClass = classMap[key] || inferClassFromKey(key);
        // A no-Range GET on a payload/monolithic class is forbidden.
        if (isPayloadClass(declaredClass)) {
            budget.reject('FORMAT_NOT_SEEKABLE', `payload-class key ${JSON.stringify(key)} (${declaredClass}) has no Range -- a no-Range GET on payload is forbidden`);
        }
        // Anti-spoof: declared AND suffix-inferred must BOTH be STRUCTURAL_JSON;
        // a .gz/.zst/.bin/unknown key declared STRUCTURAL_JSON is refused.
        const verdict = classifyStructuralTarget(key, declaredClass);
        if (!verdict.ok) {
            budget.reject('FORMAT_NOT_SEEKABLE', `structural GET-META refused for ${JSON.stringify(key)}: ${verdict.reason}`);
        }
        if (inferClassFromKey(key) !== 'STRUCTURAL_JSON') {
            budget.reject('FORMAT_NOT_SEEKABLE', `structural GET-META refused for ${JSON.stringify(key)}: suffix does not infer STRUCTURAL_JSON`);
        }
        // CHANGE D: operation/class matrix gate (belt-and-braces; effective class
        // is DERIVED here, never the free object_class_map override).
        const structDecision = decideOperation({ operation: 'GET_META', effectiveClass: verdict.effectiveClass });
        if (!structDecision.allow) {
            budget.reject('FORMAT_NOT_SEEKABLE', `structural GET-META refused for ${JSON.stringify(key)}: ${structDecision.reason}`);
        }
        // The template policy (when provided) must permit this key as a GET_META
        // CLASS-S instantiation. The effective class is DERIVED here, never the
        // free object_class_map override.
        if (templatePolicy) {
            const fam = matchFamily(templatePolicy, { operation: 'GET_META', key, effectiveClass: 'STRUCTURAL_JSON' });
            if (!fam) {
                budget.reject('FORMAT_NOT_SEEKABLE', `structural key ${JSON.stringify(key)} is not a GET_META template-derived family instantiation`);
            }
        }
        // HEAD first so we know the size BEFORE any body GET.
        budget.reserveHead();
        budget.reserveObject(key);
        const head = await guarded.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const size = head.ContentLength ?? 0;
        // Rejects (before body GET) if the object is larger than the GET-META cap.
        budget.reserveGetMeta(size);
        const expected = size;
        const limit = Math.min(expected, budget.caps.MAX_GET_META_OBJECT_BYTES);
        const got = await guarded.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        let buf;
        try {
            buf = await collectBounded(got.Body, limit);
        } catch (e) {
            if (e instanceof ResponseBoundExceeded) {
                budget.reject('INTEGRITY_ANOMALY', `GET-META body for ${JSON.stringify(key)} exceeded expected/cap`);
            }
            throw e;
        }
        if (buf.length !== expected || buf.length > budget.caps.MAX_GET_META_OBJECT_BYTES) {
            budget.reject('INTEGRITY_ANOMALY', `GET-META body for ${JSON.stringify(key)} was ${buf.length} bytes, expected ${expected} (<= ${budget.caps.MAX_GET_META_OBJECT_BYTES})`);
        }
        budget.commitGetMetaActualBytes(buf.length);
        return { key, object_class: verdict.effectiveClass, etag: got.ETag ?? head.ETag ?? null, ...structuralFacts(buf) };
    }

    async function getLocatorScalars(key) {
        if (!locatorKeys.has(key)) {
            budget.reject('OUT_OF_ALLOWLIST', `key ${JSON.stringify(key)} is not an exact structural locator key`);
        }
        noPlaceholder(key, 'locator key');
        const specs = locatorSpecsByKey.get(key);
        const declaredClass = classMap[key] || inferClassFromKey(key);
        if (isPayloadClass(declaredClass)) {
            budget.reject('FORMAT_NOT_SEEKABLE', `payload-class key ${JSON.stringify(key)} cannot use GET_LOCATOR`);
        }
        const verdict = classifyStructuralTarget(key, declaredClass);
        if (!verdict.ok || inferClassFromKey(key) !== 'STRUCTURAL_JSON') {
            budget.reject('FORMAT_NOT_SEEKABLE', `GET_LOCATOR refused for ${JSON.stringify(key)}: key is not suffix-derived STRUCTURAL_JSON`);
        }
        const decision = decideOperation({ operation: 'GET_LOCATOR', effectiveClass: verdict.effectiveClass });
        if (!decision.allow) budget.reject('FORMAT_NOT_SEEKABLE', `GET_LOCATOR refused for ${JSON.stringify(key)}: ${decision.reason}`);
        if (templatePolicy && !matchFamily(templatePolicy, { operation: 'GET_LOCATOR', key, effectiveClass: 'STRUCTURAL_JSON' })) {
            budget.reject('FORMAT_NOT_SEEKABLE', `locator key ${JSON.stringify(key)} is not an exact-key GET_LOCATOR family instantiation`);
        }

        budget.reserveHead();
        budget.reserveObject(key);
        const head = await guarded.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const expected = head.ContentLength ?? 0;
        budget.reserveGetLocator(expected);
        const got = await guarded.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (got.ContentLength != null && got.ContentLength !== expected) {
            budget.reject('INTEGRITY_ANOMALY', `GET_LOCATOR GET ContentLength ${got.ContentLength} differs from HEAD ${expected}`);
        }
        let buf;
        try { buf = await collectBounded(got.Body, Math.min(expected, budget.caps.MAX_GET_META_OBJECT_BYTES)); }
        catch (e) {
            if (e instanceof ResponseBoundExceeded) budget.reject('INTEGRITY_ANOMALY', `GET_LOCATOR body for ${JSON.stringify(key)} exceeded expected/cap`);
            throw e;
        }
        if (buf.length !== expected) {
            budget.reject('INTEGRITY_ANOMALY', `GET_LOCATOR body for ${JSON.stringify(key)} was ${buf.length} bytes, expected ${expected}`);
        }
        budget.commitGetLocatorActualBytes(buf.length);
        const extracted = extractLocators(buf, specs, { key });
        let bound;
        try {
            bound = verifySourceBinding(buf, extracted, specs, {
                head_etag: head.ETag, get_etag: got.ETag,
                head_content_length: head.ContentLength, get_content_length: got.ContentLength,
            });
        } catch (e) {
            if (/INTEGRITY_ANOMALY/.test(String(e?.message))) budget.reject('INTEGRITY_ANOMALY', e.message);
            throw e;
        }
        if (bound.source_binding_status !== 'PASS') budget.stop('INTEGRITY_ANOMALY');
        budget.reserveLocatorValues(bound.resolved);
        return bound;
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
        // CHANGE D: operation/class matrix gate (belt-and-braces).
        const rangeDecision = decideOperation({ operation: 'RANGE', effectiveClass: verdict.effectiveClass });
        if (!rangeDecision.allow) {
            budget.reject('FORMAT_NOT_SEEKABLE', `range refused for ${JSON.stringify(key)}: ${rangeDecision.reason}`);
        }
        budget.reserveRange(length); // rejects oversize single range; stops on cap
        budget.reserveObject(key);
        const end = offset + length - 1;
        const got = await guarded.send(new GetObjectCommand({
            Bucket: bucket, Key: key, Range: `bytes=${offset}-${end}`,
        }));
        // Verify the Range was honored BEFORE parsing/hashing the body: an exact
        // Content-Range and a ContentLength within the request. A provider that
        // ignored the Range (returned the full object) or mis-ranged is refused.
        if (!verifyContentRange(got.ContentRange, offset, length)) {
            budget.reject('INTEGRITY_ANOMALY', `range for ${JSON.stringify(key)} has missing/wrong Content-Range ${JSON.stringify(got.ContentRange ?? null)} (expected bytes ${offset}-${end}/<total>)`);
        }
        if (got.ContentLength != null && got.ContentLength > length) {
            budget.reject('INTEGRITY_ANOMALY', `range for ${JSON.stringify(key)} reported ContentLength ${got.ContentLength} > requested ${length}`);
        }
        let buf;
        try {
            buf = await collectBounded(got.Body, length);
        } catch (e) {
            if (e instanceof ResponseBoundExceeded) {
                budget.reject('INTEGRITY_ANOMALY', `range body for ${JSON.stringify(key)} exceeded the requested length ${length} (provider ignored Range?)`);
            }
            throw e;
        }
        if (buf.length > length || buf.length > budget.caps.MAX_SINGLE_RANGE_BYTES) {
            budget.reject('INTEGRITY_ANOMALY', `range body for ${JSON.stringify(key)} was ${buf.length} bytes, exceeds requested ${length} / cap ${budget.caps.MAX_SINGLE_RANGE_BYTES}`);
        }
        budget.commitRangeActualBytes(buf.length);
        return {
            key, offset, length, object_class: verdict.effectiveClass, etag: got.ETag ?? null,
            ...sampleFacts(buf, budget.caps.MAX_DECODED_BYTES_PER_SAMPLE),
        };
    }

    // Read-only COUNTERS snapshot (NOT the guard itself -- no send is exposed).
    const guardCounters = () => ({
        network_calls_after_stop: guarded.network_calls_after_stop,
        attempts_after_stop: guarded.attempts_after_stop,
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

    // EXACTLY the five typed methods (+ a counters snapshot). No generic
    // send(command) / request(method,key) / getObject(key) is exposed.
    return {
        bucket,
        listExactPrefix,
        headExactKey,
        getStructuralMetadata,
        getLocatorScalars,
        readLocatorBoundRange,
        guardCounters,
    };
}
