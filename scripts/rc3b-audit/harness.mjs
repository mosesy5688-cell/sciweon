/**
 * RC-3B-P0B -- execution orchestrator (READ-ONLY, cap-bounded).
 *
 * Validates the run manifest (fail-before-network on any inadmissibility), then
 * drives the four typed read primitives across the committed allowlist under the
 * Budget. It records PHYSICAL observations only (presence / size / etag / shape
 * signature) -- never a payload value. Any per-target rejection is logged and
 * pushed to the follow-up queue (never silently dropped); once the Budget is
 * STOPPED, remaining targets are queued and NO further network call is made.
 *
 * This module performs NO evidence assembly and NO schema/leak work -- that is
 * evidence-assembly.mjs. It constructs NO client itself: the caller injects either
 * the minimal read-only client (client-factory) or, in tests, a fake.
 */

import { Budget, RunStoppedError, CapExceededError } from './budget.mjs';
import { validateRunManifest } from './run-manifest.mjs';
import { makeReadOnlyR2Client } from './readonly-client.mjs';
import { loadTemplatePolicy } from './template-policy.mjs';
import { StructuralLogger } from './logger.mjs';

/**
 * Map a thrown error to a follow-up reason_code. An INTEGRITY_ANOMALY (a provider
 * that violated an invariant: LIST over-return, GET-META/Range over-return or
 * body-size mismatch, actual-bytes > reserved) is thrown as a CapExceededError
 * carrying `(reason=INTEGRITY_ANOMALY)`, so its MESSAGE is checked FIRST -- ahead
 * of both the RunStoppedError and CapExceededError->CAP_REACHED branches -- so it
 * is never mislabeled CAP_REACHED. CAP_REACHED stays ONLY for real configured cap
 * exhaustion (page/key/byte/object/range-count/get-meta caps, single-range-too-
 * large, get-meta-object-too-large) which surface as RunStoppedError or a
 * CAP_REACHED-tagged CapExceededError.
 */
export function reasonCodeFor(err) {
    const m = String(err && err.message);
    if (/INTEGRITY_ANOMALY/i.test(m)) return 'INTEGRITY_ANOMALY';
    if (err instanceof RunStoppedError) return 'CAP_REACHED';
    if (/FORMAT_NOT_SEEKABLE|not seekable|no arbitrary/i.test(m)) return 'FORMAT_NOT_SEEKABLE';
    if (/UNRESOLVED_PLACEHOLDER|placeholder/i.test(m)) return 'PREFIX_NOT_AUTHORIZED';
    if (/OUT_OF_ALLOWLIST|not an exact/i.test(m)) return 'PREFIX_NOT_AUTHORIZED';
    if (err instanceof CapExceededError) return 'CAP_REACHED';
    return 'OTHER_SANITIZED';
}

function detailToken(err) {
    if (err instanceof RunStoppedError) return 'RUN-STOPPED-CAP';
    if (err instanceof CapExceededError) return 'CAP-EXCEEDED';
    return 'REJECTED-BEFORE-NETWORK';
}

/**
 * @param {object} plan       parsed run manifest
 * @param {Buffer} rawBytes   the manifest file bytes (for provenance only)
 * @param {object} opts       { allowedBuckets, clientOverride, now }
 * @returns {object} runResult
 */
export async function runReadOnlyAudit(plan, rawBytes, opts = {}) {
    const validation = validateRunManifest(plan, { allowedBuckets: opts.allowedBuckets || [] });
    if (!validation.admissible) {
        throw new Error(`[RC3B HARNESS] run manifest INADMISSIBLE -- fail-before-network:\n - ${validation.errors.join('\n - ')}`);
    }
    const rawClient = opts.clientOverride || null;
    if (!rawClient) {
        throw new Error('[RC3B HARNESS] no read-only client available -- harness is INERT without provisioned read-only credentials');
    }

    const budget = new Budget(plan.caps || {}, opts.now);
    const logger = new StructuralLogger();
    const templatePolicy = opts.templatePolicy || loadTemplatePolicy();
    const client = makeReadOnlyR2Client(rawClient, plan, budget, templatePolicy);
    const observations = [];
    const followup = [];

    const queue = (item_ref, err) => {
        const reason = reasonCodeFor(err);
        logger.event('followup', { key: item_ref, reason });
        followup.push({ item_ref, reason_code: reason, proposed_next_gate: 'RC3B-P1-RESOLVE', detail_sanitized: detailToken(err) });
    };
    const stoppedQueue = (item_ref) => followup.push({ item_ref, reason_code: 'CAP_REACHED', proposed_next_gate: 'RC3B-P1-SEPARATE-RUN', detail_sanitized: 'SKIPPED-AFTER-STOP' });

    // ---- LIST exact prefixes -------------------------------------------------
    for (const prefix of plan.exact_prefixes || []) {
        if (budget.stopped) { stoppedQueue(prefix); continue; }
        try {
            const r = await client.listExactPrefix(prefix);
            logger.event('list', { prefix, pages: r.pages, keys: r.keys.length });
            for (const o of r.keys) {
                observations.push({ object_key: o.key, kind: 'listed', physical_presence: 'R2_OBJECT_PRESENT', byte_or_record_count: o.size, hash_or_etag: o.etag || '' });
            }
        } catch (err) { queue(prefix, err); }
    }

    // ---- structural GET-META (small metadata) -------------------------------
    for (const key of plan.structural_keys || []) {
        if (budget.stopped) { stoppedQueue(key); continue; }
        try {
            const f = await client.getStructuralMetadata(key);
            logger.event('get_meta', { key, bytes: f.byte_length, shape: f.shape_signature_sha256 });
            observations.push({
                object_key: key, kind: 'structural', physical_presence: 'R2_OBJECT_PRESENT',
                byte_or_record_count: f.byte_length, hash_or_etag: f.etag || f.byte_sha256,
                sample: { sample_kind: 'SHAPE-SIGNATURE', observed_field_paths: f.top_level_property_names, shape_signature_sha256: f.shape_signature_sha256, sample_bytes_read: f.byte_length, sample_decoded_bytes: f.byte_length },
            });
        } catch (err) { queue(key, err); }
    }

    // ---- HEAD-only class-C keys ---------------------------------------------
    for (const key of plan.class_c_head_keys || []) {
        if (budget.stopped) { stoppedQueue(key); continue; }
        try {
            const h = await client.headExactKey(key);
            logger.event('head', { key, bytes: h.content_length });
            observations.push({ object_key: key, kind: 'head', physical_presence: 'R2_OBJECT_PRESENT', byte_or_record_count: h.content_length, hash_or_etag: h.etag || '' });
        } catch (err) { queue(key, err); }
    }

    // ---- class-X locator-bound Range reads ----------------------------------
    for (const t of plan.class_x_targets || []) {
        if (budget.stopped) { stoppedQueue(t.key); continue; }
        try {
            const s = await client.readLocatorBoundRange(t.key, t.offset, t.length);
            logger.event('range', { key: t.key, off: t.offset, len: t.length, shape: s.shape_signature_sha256 });
            observations.push({
                object_key: t.key, kind: 'range', physical_presence: 'R2_OBJECT_PRESENT',
                byte_or_record_count: -1, hash_or_etag: s.etag || '',
                sample: { sample_kind: 'SHAPE-SIGNATURE', shape_signature_sha256: s.shape_signature_sha256, sample_bytes_read: s.sample_bytes_read, sample_decoded_bytes: s.sample_decoded_bytes },
            });
        } catch (err) { queue(t.key, err); }
    }

    return {
        observations, followup, budget, logger, guard_counters: client.guardCounters(),
        logLines: logger.lines, partial: budget.partial, stop_reasons: budget.stopReasonList(),
    };
}
