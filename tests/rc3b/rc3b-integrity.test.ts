// @ts-nocheck
/**
 * RC-3B-P0B INTEGRITY_ANOMALY follow-up classification (CHANGE D). A provider
 * that violates an invariant (here: a GET-META body larger than the HEAD-declared
 * size) STOPS the run with stop_reason INTEGRITY_ANOMALY AND is queued with
 * reason_code INTEGRITY_ANOMALY -- never collapsed into CAP_REACHED. A genuinely
 * configured cap still yields CAP_REACHED. reasonCodeFor keeps the two distinct.
 */
import { describe, it, expect } from 'vitest';
import { runReadOnlyAudit, reasonCodeFor } from '../../scripts/rc3b-audit/harness.mjs';
import { validateRunManifest } from '../../scripts/rc3b-audit/run-manifest.mjs';
import { CapExceededError, RunStoppedError } from '../../scripts/rc3b-audit/budget.mjs';
import { allowlistSha256, runPlanSha256 } from '../../scripts/rc3b-audit/manifest-hash.mjs';
import {
    syntheticRunManifest, manifestBodyBuffer, makeSyntheticFakeClient, SYNTHETIC_ALLOWED_BUCKETS,
} from '../../scripts/rc3b-audit/self-test.mjs';

const MANIFEST_KEY = 'synthetic/prefix/manifest.json';
const OK = { allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS };

function reseal(plan) {
    plan.materialized_allowlist_sha256 = allowlistSha256(plan);
    plan.materialized_run_plan_sha256 = runPlanSha256(plan);
    return plan;
}
function validateAdmissible(plan) { return validateRunManifest(plan, OK).admissible; }

/** A fake whose GET-META body is one byte larger than the HEAD-declared size. */
function overReturningMetaClient() {
    const manifest = manifestBodyBuffer();
    const over = Buffer.concat([manifest, Buffer.from([0])]);
    return {
        async send(command) {
            const ctor = command?.constructor?.name; const i = command?.input || {};
            if (ctor === 'ListObjectsV2Command') return { IsTruncated: false, Contents: [] };
            if (ctor === 'HeadObjectCommand') return { ETag: '"m"', ContentLength: manifest.length };
            if (ctor === 'GetObjectCommand' && !i.Range) return { ETag: '"m"', ContentLength: manifest.length, Body: over };
            if (ctor === 'GetObjectCommand' && i.Range) return { ETag: '"s"', ContentRange: 'bytes 0-63/4096', ContentLength: 64, Body: Buffer.alloc(64, 1) };
            throw new Error(`over-return fake: unhandled ${ctor}`);
        },
    };
}

describe('RC-3B-P0B reasonCodeFor: INTEGRITY_ANOMALY and CAP_REACHED stay distinct', () => {
    it('an INTEGRITY_ANOMALY-tagged CapExceededError maps to INTEGRITY_ANOMALY', () => {
        expect(reasonCodeFor(new CapExceededError('[RC3B BUDGET] range actual bytes 65 exceed reserved 64 (reason=INTEGRITY_ANOMALY)'))).toBe('INTEGRITY_ANOMALY');
    });
    it('a CAP_REACHED-tagged CapExceededError maps to CAP_REACHED', () => {
        expect(reasonCodeFor(new CapExceededError('[RC3B BUDGET] single range too large (reason=CAP_REACHED)'))).toBe('CAP_REACHED');
    });
    it('a RunStoppedError (cap exhaustion) maps to CAP_REACHED', () => {
        expect(reasonCodeFor(new RunStoppedError('[RC3B BUDGET] run is STOPPED'))).toBe('CAP_REACHED');
    });
});

describe('RC-3B-P0B harness: provider over-return -> INTEGRITY_ANOMALY follow-up', () => {
    it('stop_reasons includes INTEGRITY_ANOMALY and the offending item is queued INTEGRITY_ANOMALY', async () => {
        const plan = syntheticRunManifest();
        const runResult = await runReadOnlyAudit(plan, Buffer.from('{}'), {
            allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, clientOverride: overReturningMetaClient(),
        });
        expect(runResult.stop_reasons).toContain('INTEGRITY_ANOMALY');
        const offending = runResult.followup.find((f) => f.item_ref === MANIFEST_KEY);
        expect(offending).toBeTruthy();
        expect(offending.reason_code).toBe('INTEGRITY_ANOMALY');
        // Items skipped AFTER the stop are CAP_REACHED -- the two coexist distinctly.
        expect(runResult.followup.some((f) => f.reason_code === 'CAP_REACHED')).toBe(true);
    });
});

describe('RC-3B-P0B harness: a genuinely configured cap -> CAP_REACHED (not INTEGRITY_ANOMALY)', () => {
    it('a HEAD cap of 0 stops the run with CAP_REACHED only', async () => {
        const plan = reseal({ ...syntheticRunManifest(), caps: { MAX_HEAD_REQUESTS_PER_RUN: 0 } });
        expect(validateAdmissible(plan)).toBe(true);
        const runResult = await runReadOnlyAudit(plan, Buffer.from('{}'), {
            allowedBuckets: SYNTHETIC_ALLOWED_BUCKETS, clientOverride: makeSyntheticFakeClient(),
        });
        expect(runResult.stop_reasons).toContain('CAP_REACHED');
        expect(runResult.stop_reasons).not.toContain('INTEGRITY_ANOMALY');
        const offending = runResult.followup.find((f) => f.item_ref === MANIFEST_KEY);
        expect(offending.reason_code).toBe('CAP_REACHED');
    });
});
