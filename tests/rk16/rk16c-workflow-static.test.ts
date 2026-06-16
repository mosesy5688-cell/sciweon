// @ts-nocheck
/**
 * RK-16C MANIFEST-ONLY PREFLIGHT WORKFLOW — STATIC SECURITY AUDIT.
 *
 * Parses .github/workflows/rk16c-manifest-preflight.yml (with js-yaml, already a
 * transitive dependency) AND applies robust text/regex assertions. ZERO network,
 * no creds, no production R2. Covers build-stage checks 1-15 + the negative
 * assertions (no secrets:inherit / set -x / continue-on-error / `|| true` /
 * SHA-verification bypass). See rk16c-workflow-sim.test.ts for check 16.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.resolve(HERE, '../../.github/workflows/rk16c-manifest-preflight.yml');
const RAW = fs.readFileSync(WF_PATH, 'utf-8');
const DOC: any = yaml.load(RAW);

// D-103 A1: repinned audited runner SHA (supersedes the consumed b0b8246 runner).
const AUDITED_RUNNER_SHA = '7e4fa65d38e8b8b359c82070432db952b670b26f';
const SNAPSHOT = '2026-06-14/27502029137-1';
const MANIFEST_KEY = 'snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json';
const PAYLOAD_KEY = 'snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz';
const EXACT_CMD =
    'node scripts/spikes/rk16c/run-fullcorpus.mjs --preflight --execute '
    + `--snapshot ${SNAPSHOT} --manifest-key ${MANIFEST_KEY}`;

// js-yaml parses the unquoted `on:` key to boolean true; read the raw `on` block.
function job() { return DOC.jobs['manifest-preflight']; }
function allUses(): string[] {
    return job().steps.filter((s: any) => s.uses).map((s: any) => s.uses);
}

describe('check 1 — YAML parses', () => {
    it('parses to an object with name + on + permissions + jobs', () => {
        expect(DOC && typeof DOC === 'object').toBe(true);
        expect(typeof DOC.name).toBe('string');
        expect(DOC.jobs && DOC.jobs['manifest-preflight']).toBeTruthy();
    });
});

describe('check 2/3 — trigger is workflow_dispatch ONLY, no inputs', () => {
    it('on is exactly workflow_dispatch (js-yaml maps bare on -> true key)', () => {
        const on = DOC.on ?? DOC[true as any];
        expect(on).toHaveProperty('workflow_dispatch');
        expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    });
    it('none of the forbidden triggers are present (raw text)', () => {
        for (const t of [
            'repository_dispatch', 'pull_request_target', 'workflow_call',
            'workflow_run', 'schedule',
        ]) {
            expect(RAW.includes(`${t}:`)).toBe(false);
        }
        // `push:` and `pull_request:` must not be event keys (comment mentions ok).
        expect(/^\s+push:/m.test(RAW)).toBe(false);
        expect(/^\s+pull_request:/m.test(RAW)).toBe(false);
    });
    it('workflow_dispatch has NO inputs / no free-text', () => {
        const on = DOC.on ?? DOC[true as any];
        const wd = on.workflow_dispatch;
        expect(wd == null || wd.inputs == null).toBe(true);
        expect(/inputs:/.test(RAW)).toBe(false);
    });
});

describe('check 4/11 — permissions == contents:read, no write, no id-token', () => {
    it('top-level permissions is exactly { contents: read }', () => {
        expect(DOC.permissions).toEqual({ contents: 'read' });
    });
    it('no write scope granted and no id-token scope anywhere', () => {
        // The ONLY permissions entry is contents:read (asserted above). No scope
        // is granted write, and id-token is not a key in permissions.
        const perms = DOC.permissions || {};
        for (const v of Object.values(perms)) expect(v).not.toBe('write');
        expect(Object.keys(perms)).not.toContain('id-token');
        // No `<scope>: write` grant line anywhere (comments are prose, not grants).
        expect(/^\s*[a-z-]+:\s*write\s*$/m.test(RAW)).toBe(false);
        // id-token must never be GRANTED as a permission scope (a prose mention
        // explaining it is intentionally absent is fine).
        expect(/^\s*id-token:/m.test(RAW)).toBe(false);
    });
});

describe('check 5 — every `uses:` is a 40-hex SHA pin, no floating tags', () => {
    const SHA_PIN = /@[0-9a-f]{40}(\s|$)/;
    it('all uses are SHA-pinned', () => {
        const uses = allUses();
        expect(uses.length).toBeGreaterThanOrEqual(3);
        for (const u of uses) {
            expect(SHA_PIN.test(u + ' ')).toBe(true);
        }
    });
    it('no @v4 / @main / floating refs on any uses line', () => {
        const useLines = RAW.split('\n').filter((l) => /^\s*uses:/.test(l));
        for (const l of useLines) {
            const ref = l.split('@')[1].trim().split(/\s/)[0];
            expect(/^[0-9a-f]{40}$/.test(ref)).toBe(true);
            expect(/^v\d/.test(ref)).toBe(false);
            expect(ref).not.toBe('main');
        }
    });
});

describe('check 6/12 — checkout ref == AUDITED_RUNNER_SHA; environment bound', () => {
    it('checkout step pins ref to the exact audited runner SHA', () => {
        const checkout = job().steps.find((s: any) => (s.uses || '').includes('actions/checkout'));
        expect(checkout.with.ref).toBe(AUDITED_RUNNER_SHA);
        expect(checkout.with['persist-credentials']).toBe(false);
    });
    it('job is bound to environment rk16c-manifest-preflight', () => {
        expect(job().environment).toBe('rk16c-manifest-preflight');
    });
});

describe('check 7/8/9 — exact snapshot + manifest key + command; no payload key', () => {
    it('hardcoded exact snapshot + manifest key present', () => {
        expect(RAW.includes(`--snapshot ${SNAPSHOT}`)).toBe(true);
        expect(RAW.includes(`--manifest-key ${MANIFEST_KEY}`)).toBe(true);
    });
    it('the exact preflight command is present verbatim', () => {
        const cmdStep = job().steps.find((s: any) => (s.run || '').includes('run-fullcorpus.mjs'));
        expect((cmdStep.run || '').trim()).toBe(EXACT_CMD);
    });
    it('NO payload key / bioactivities.jsonl.gz appears in any run command', () => {
        const runs = job().steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
        expect(runs.includes(PAYLOAD_KEY)).toBe(false);
        expect(runs.includes('bioactivities.jsonl.gz')).toBe(false);
    });
});

describe('check 10 — no List/aws/curl/s3 ls/bucket-inspection step', () => {
    it('no run step performs listing / bucket inspection', () => {
        const runs = job().steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
        for (const bad of ['aws s3', 's3 ls', 'aws ', 'curl ', 'ListObjects', 'list-objects', 'rclone', 'wget ']) {
            expect(runs.includes(bad)).toBe(false);
        }
    });
});

describe('check 13 — run_attempt!=1 guard FIRST, before checkout/creds', () => {
    it('first step is the run-attempt guard with the != 1 condition', () => {
        const steps = job().steps;
        const guardIdx = steps.findIndex((s: any) => /run_attempt/.test(JSON.stringify(s.if || '')));
        const checkoutIdx = steps.findIndex((s: any) => (s.uses || '').includes('actions/checkout'));
        expect(guardIdx).toBe(0);
        expect(guardIdx).toBeLessThan(checkoutIdx);
        expect(String(steps[guardIdx].if)).toContain("github.run_attempt != '1'");
        expect(String(steps[guardIdx].run)).toContain('exit 1');
    });
});

describe('check 14 — concurrency group fixed (static), no dynamic key', () => {
    it('concurrency group is the static string and cancel-in-progress is false', () => {
        expect(DOC.concurrency.group).toBe('rk16c-manifest-preflight');
        expect(DOC.concurrency['cancel-in-progress']).toBe(false);
        // No GitHub-context expansion in the group value.
        expect(/group:\s*rk16c-manifest-preflight\s*$/m.test(RAW)).toBe(true);
        expect(/group:.*\$\{\{/.test(RAW)).toBe(false);
    });
});

describe('check 15 — upload-artifact allowlist == ONLY candidate lock, finite retention', () => {
    it('upload step paths only the candidate lock, finite retention-days', () => {
        const up = job().steps.find((s: any) => (s.uses || '').includes('actions/upload-artifact'));
        expect(up.with.path).toBe('scripts/spikes/rk16c/results/RK16C_FULLCORPUS_LOCK.candidate.json');
        expect(Number.isInteger(up.with['retention-days'])).toBe(true);
        expect(up.with['retention-days']).toBeGreaterThan(0);
        expect(up.with['retention-days']).toBeLessThanOrEqual(90);
        // The upload path must NOT reference payload / env / results glob.
        expect(String(up.with.path).includes('bioactivities')).toBe(false);
        expect(String(up.with.path).includes('*')).toBe(false);
    });
});

describe('negative assertions — no dangerous patterns / bypasses', () => {
    it('no secrets:inherit, set -x, continue-on-error, `|| true` in executable parts', () => {
        // Assert against the executable surface (job steps), not prose comments.
        const steps = job().steps;
        const runs = steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
        // `secrets: inherit` must not be a field (a prose comment is fine).
        expect(/^\s*secrets:\s*inherit\s*$/m.test(RAW)).toBe(false);
        expect((job() as any).secrets).toBeUndefined();
        expect(/set\s+-x/.test(runs)).toBe(false);
        expect(runs.includes('|| true')).toBe(false);
        for (const s of steps) expect(s['continue-on-error']).not.toBe(true);
        expect(/continue-on-error:\s*true/.test(RAW)).toBe(false);
    });
    it('SHA-verification step has no bypass (the != check + exit 1 is present)', () => {
        const verify = job().steps.find((s: any) => /rev-parse HEAD/.test(s.run || ''));
        expect(verify).toBeTruthy();
        // The audited SHA is bound via step env; the run compares against it.
        expect(verify.env.AUDITED_RUNNER_SHA).toBe(AUDITED_RUNNER_SHA);
        expect(String(verify.run)).toMatch(/!=\s*"\$\{AUDITED_RUNNER_SHA\}"/);
        expect(String(verify.run)).toContain('exit 1');
        // No `if:` skip / bypass on the verify step.
        expect(verify.if == null || verify.if === true).toBe(true);
    });
    it('candidate lock is documented as UNRATIFIED / not authorized for payload', () => {
        expect(RAW.includes('UNRATIFIED')).toBe(true);
        expect(/NOT AUTHORIZED FOR PAYLOAD READ/i.test(RAW)).toBe(true);
    });
});
