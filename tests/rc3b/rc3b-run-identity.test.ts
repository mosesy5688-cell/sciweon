// @ts-nocheck
/**
 * RC-3B-P0B EXACT run-identity binding (CHANGE A). assertRunIdentity requires a
 * TAG ref whose name is the authorized carrier tag, the authorized harness SHA,
 * run_attempt==1, AND the ONE authorized workflow run id -- each a hard gate.
 * run_attempt==1 is necessary but NOT sufficient: a second independent dispatch
 * (new run id, attempt 1) is rejected. Wired into runAuthorizedAudit, every gap
 * fails BEFORE the client with ZERO network calls.
 */
import { describe, it, expect } from 'vitest';
import { assertRunIdentity } from '../../scripts/rc3b-audit/run-identity.mjs';
import { authorizedScenario, runScenario } from './rc3b-authorized-fixtures';

const SHA = 'a'.repeat(40);
function goodId(over = {}) {
    return {
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'carrier-x',
        RC3B_AUTHORIZED_CARRIER_TAG: 'carrier-x',
        GITHUB_SHA: SHA,
        RC3B_AUTHORIZED_HARNESS_SHA: SHA,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_RUN_ID: '100',
        RC3B_AUTHORIZED_WORKFLOW_RUN_ID: '100',
        ...over,
    };
}

describe('RC-3B-P0B run-identity: assertRunIdentity (pure)', () => {
    const M = /\[RC3B IDENTITY\]/;

    it('a fully-bound identity returns the carrier tag + run id + attempt==1', () => {
        const r = assertRunIdentity(goodId());
        expect(r).toEqual({ carrier_tag: 'carrier-x', workflow_run_id: '100', run_attempt: 1 });
    });

    it('a BRANCH ref (not a tag) is rejected', () => {
        expect(() => assertRunIdentity(goodId({ GITHUB_REF_TYPE: 'branch' }))).toThrow(M);
    });
    it('a ref-name != authorized carrier tag is rejected', () => {
        expect(() => assertRunIdentity(goodId({ GITHUB_REF_NAME: 'other-tag' }))).toThrow(M);
    });
    it('a missing authorized carrier tag is rejected', () => {
        const e = goodId(); delete e.RC3B_AUTHORIZED_CARRIER_TAG;
        expect(() => assertRunIdentity(e)).toThrow(M);
    });
    it('GITHUB_SHA != authorized harness SHA is rejected', () => {
        expect(() => assertRunIdentity(goodId({ GITHUB_SHA: 'b'.repeat(40) }))).toThrow(M);
    });
    it('run_attempt != 1 (a re-run) is rejected', () => {
        expect(() => assertRunIdentity(goodId({ GITHUB_RUN_ATTEMPT: '2' }))).toThrow(M);
    });
    it('GITHUB_RUN_ID != authorized run id is rejected', () => {
        expect(() => assertRunIdentity(goodId({ GITHUB_RUN_ID: '200' }))).toThrow(M);
    });
    it('run_attempt==1 is necessary but NOT sufficient: a second dispatch (new run id, attempt 1) is rejected', () => {
        expect(() => assertRunIdentity(goodId({ GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '1' }))).toThrow(M);
    });
});

describe('RC-3B-P0B run-identity: wired into runAuthorizedAudit (fail-before-client, 0 network)', () => {
    const spy = () => ({ sends: 0, async send() { this.sends += 1; return {}; } });
    const expect0Net = async (envOverride) => {
        const scn = authorizedScenario({ envOverride });
        const s = spy();
        await expect(runScenario(scn, s)).rejects.toThrow(/IDENTITY|MISSING_AUTHORIZATION/);
        expect(s.sends).toBe(0);
    };

    it('wrong tag -> 0 network', () => expect0Net({ GITHUB_REF_NAME: 'wrong-tag' }));
    it('a branch ref instead of a tag -> 0 network', () => expect0Net({ GITHUB_REF_TYPE: 'branch' }));
    it('wrong SHA -> 0 network', () => expect0Net({ GITHUB_SHA: 'c'.repeat(40) }));
    it('run_attempt > 1 -> 0 network', () => expect0Net({ GITHUB_RUN_ATTEMPT: '2' }));
    it('wrong GITHUB_RUN_ID -> 0 network', () => expect0Net({ GITHUB_RUN_ID: '999999' }));
    it('a second independent dispatch (new run id, attempt 1) -> 0 network', () => expect0Net({ GITHUB_RUN_ID: '777777', GITHUB_RUN_ATTEMPT: '1' }));
});
