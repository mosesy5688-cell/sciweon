/**
 * P0.2 deployment identity -- the validation table for
 * `resolveDeploymentIdentity` (brief section 4, tests 1 and 2).
 *
 * Every row asserts ALL FIVE identity fields, including
 * `worker_version_id` / `worker_version_timestamp`, so the independence rule
 * is exercised in BOTH directions: an invalid `tag` never suppresses a valid
 * `id`, and a valid `id` never makes the deployment identity available.
 *
 * The resolver is TOTAL: no row is allowed to throw.
 */

import { describe, it, expect } from 'vitest';
import { resolveDeploymentIdentity } from '../../src/worker/api/health';

const VALID_SHA = 'c88c1f525d623f0b3a16715551d3a5983438e36a';
const UPPER_SHA = VALID_SHA.toUpperCase();
const MIXED_SHA = 'C88c1f525d623f0b3a16715551d3a5983438e36A';
const ID = 'abcdef12-3456-7890';
const TS = '2026-09-02T00:00:00.000Z';

// A 129-character printable-ASCII string: one over the 1..128 bound.
const ID_TOO_LONG = 'x'.repeat(129);
// A printable string carrying one non-printable byte (written as an escape so
// the source file itself contains no control byte).
const ID_NON_PRINTABLE = 'ab\u0001cd';

function throwingTagBinding(): unknown {
    return {
        get tag(): never { throw new Error(); },
        id: ID,
        timestamp: TS,
    };
}

function throwingIdBinding(): unknown {
    return {
        tag: VALID_SHA,
        get id(): never { throw new Error(); },
        timestamp: TS,
    };
}

interface Row {
    name: string;
    binding: unknown;
    status: 'available' | 'unavailable';
    gitSha: string | null;
    id: string | null;
    ts: string | null;
    reason: string | null;
}

const ROWS: Row[] = [
    // --- tag shape ---------------------------------------------------------
    { name: 'valid 40-lowercase-hex tag', binding: { tag: VALID_SHA, id: ID, timestamp: TS },
      status: 'available', gitSha: VALID_SHA, id: ID, ts: TS, reason: null },
    // The independence row required by the brief: an INVALID tag carrying a
    // well-formed id and timestamp. git_sha is null AND worker_version_id is
    // not null, in the same row.
    { name: 'uppercase 40-hex tag is unavailable, never lowercased', binding: { tag: UPPER_SHA, id: ID, timestamp: TS },
      status: 'unavailable', gitSha: null, id: ID, ts: TS, reason: 'tag_not_40_lowercase_hex' },
    { name: 'mixed-case 40-hex tag', binding: { tag: MIXED_SHA, id: ID, timestamp: TS },
      status: 'unavailable', gitSha: null, id: ID, ts: TS, reason: 'tag_not_40_lowercase_hex' },
    { name: '39-hex tag', binding: { tag: VALID_SHA.slice(0, 39) },
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_not_40_lowercase_hex' },
    { name: '41-hex tag', binding: { tag: VALID_SHA + 'a' },
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_not_40_lowercase_hex' },
    { name: '40-char non-hex tag', binding: { tag: 'z'.repeat(40) },
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_not_40_lowercase_hex' },
    { name: 'tag with a trailing newline and payload', binding: { tag: VALID_SHA + '\nEVIL' },
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_not_40_lowercase_hex' },
    { name: 'tag with leading whitespace', binding: { tag: ' ' + VALID_SHA },
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_not_40_lowercase_hex' },
    { name: 'tag with trailing whitespace', binding: { tag: VALID_SHA + ' ' },
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_not_40_lowercase_hex' },
    { name: 'empty tag', binding: { tag: '' },
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_empty' },
    { name: 'non-string tag', binding: { tag: 12345, id: ID, timestamp: TS },
      status: 'unavailable', gitSha: null, id: ID, ts: TS, reason: 'tag_absent' },
    { name: 'tag missing', binding: { id: ID, timestamp: TS },
      status: 'unavailable', gitSha: null, id: ID, ts: TS, reason: 'tag_absent' },
    { name: 'binding is an empty object', binding: {},
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'tag_absent' },

    // --- binding shape -----------------------------------------------------
    { name: 'binding is null', binding: null,
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'binding_absent' },
    { name: 'binding is undefined', binding: undefined,
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'binding_absent' },
    { name: 'binding is a string (non-object)', binding: 'not-an-object',
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'binding_absent' },
    { name: 'binding is a number (non-object)', binding: 42,
      status: 'unavailable', gitSha: null, id: null, ts: null, reason: 'binding_absent' },

    // --- throwing getters --------------------------------------------------
    { name: 'tag getter throws -> binding_read_failed, id/timestamp still emitted',
      binding: throwingTagBinding(),
      status: 'unavailable', gitSha: null, id: ID, ts: TS, reason: 'binding_read_failed' },
    { name: 'id getter throws while tag reads cleanly -> still available',
      binding: throwingIdBinding(),
      status: 'available', gitSha: VALID_SHA, id: null, ts: TS, reason: null },

    // --- id / timestamp bounds --------------------------------------------
    { name: 'id missing', binding: { tag: VALID_SHA, timestamp: TS },
      status: 'available', gitSha: VALID_SHA, id: null, ts: TS, reason: null },
    { name: 'timestamp missing', binding: { tag: VALID_SHA, id: ID },
      status: 'available', gitSha: VALID_SHA, id: ID, ts: null, reason: null },
    { name: 'id and timestamp both missing', binding: { tag: VALID_SHA },
      status: 'available', gitSha: VALID_SHA, id: null, ts: null, reason: null },
    { name: 'id of 129 characters is rejected whole (no truncation)',
      binding: { tag: VALID_SHA, id: ID_TOO_LONG, timestamp: TS },
      status: 'available', gitSha: VALID_SHA, id: null, ts: TS, reason: null },
    { name: 'id containing a non-printable byte is rejected whole',
      binding: { tag: VALID_SHA, id: ID_NON_PRINTABLE, timestamp: TS },
      status: 'available', gitSha: VALID_SHA, id: null, ts: TS, reason: null },
    { name: 'timestamp of 129 characters is rejected whole',
      binding: { tag: VALID_SHA, id: ID, timestamp: ID_TOO_LONG },
      status: 'available', gitSha: VALID_SHA, id: ID, ts: null, reason: null },
    { name: 'non-string id and timestamp are rejected',
      binding: { tag: VALID_SHA, id: 7, timestamp: {} },
      status: 'available', gitSha: VALID_SHA, id: null, ts: null, reason: null },
];

describe('resolveDeploymentIdentity -- validation table (brief test 1)', () => {
    for (const row of ROWS) {
        it(row.name, () => {
            const r = resolveDeploymentIdentity(row.binding);
            expect(r.deployment_identity_status, 'deployment_identity_status').toBe(row.status);
            expect(r.git_sha, 'git_sha').toBe(row.gitSha);
            expect(r.worker_version_id, 'worker_version_id').toBe(row.id);
            expect(r.worker_version_timestamp, 'worker_version_timestamp').toBe(row.ts);
            expect(r.deployment_identity_reason, 'deployment_identity_reason').toBe(row.reason);
        });
    }

    it('is TOTAL: not one row throws', () => {
        for (const row of ROWS) {
            expect(() => resolveDeploymentIdentity(row.binding), row.name).not.toThrow();
        }
    });

    it('exercises independence in both directions', () => {
        // Invalid tag + well-formed id: git_sha null, worker_version_id NOT null.
        const invalidTagValidId = resolveDeploymentIdentity({ tag: UPPER_SHA, id: ID, timestamp: TS });
        expect(invalidTagValidId.git_sha).toBeNull();
        expect(invalidTagValidId.worker_version_id).not.toBeNull();
        expect(invalidTagValidId.deployment_identity_status).toBe('unavailable');
        // Valid tag + rejected id: identity is still available.
        const validTagBadId = resolveDeploymentIdentity({ tag: VALID_SHA, id: ID_TOO_LONG });
        expect(validTagBadId.deployment_identity_status).toBe('available');
        expect(validTagBadId.git_sha).toBe(VALID_SHA);
        expect(validTagBadId.worker_version_id).toBeNull();
    });

    it('returns git_sha VERBATIM -- the same string, not a copy of a slice', () => {
        const tag = VALID_SHA;
        expect(resolveDeploymentIdentity({ tag }).git_sha).toBe(tag);
    });

    it('never echoes a rejected tag into any field', () => {
        const rejected = UPPER_SHA;
        const r = resolveDeploymentIdentity({ tag: rejected, id: ID, timestamp: TS });
        expect(JSON.stringify(r)).not.toContain(rejected);
        expect(JSON.stringify(r)).not.toContain(VALID_SHA);
    });

    it('the predicate has no flags: .test() does not alternate across calls', () => {
        for (let i = 0; i < 4; i++) {
            expect(resolveDeploymentIdentity({ tag: VALID_SHA }).git_sha, `call ${i}`).toBe(VALID_SHA);
        }
    });
});

describe('resolveDeploymentIdentity -- "at least contains" (brief test 2)', () => {
    it('an extra unknown property still yields available', () => {
        const r = resolveDeploymentIdentity({
            tag: VALID_SHA, id: ID, timestamp: TS, someFuturePlatformField: { nested: true },
        });
        expect(r.deployment_identity_status).toBe('available');
        expect(r.git_sha).toBe(VALID_SHA);
        expect(r.worker_version_id).toBe(ID);
        expect(r.worker_version_timestamp).toBe(TS);
        expect(r.deployment_identity_reason).toBeNull();
    });

    it('an extra unknown property whose getter throws does not change the outcome', () => {
        const r = resolveDeploymentIdentity({
            tag: VALID_SHA,
            id: ID,
            timestamp: TS,
            get somethingElse(): never { throw new Error(); },
        });
        expect(r.deployment_identity_status).toBe('available');
        expect(r.git_sha).toBe(VALID_SHA);
    });
});
