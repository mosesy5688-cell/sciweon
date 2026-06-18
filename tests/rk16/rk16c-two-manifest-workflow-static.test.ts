// @ts-nocheck
/**
 * RK-16C TWO-MANIFEST PREFLIGHT WORKFLOW — STATIC SECURITY AUDIT (D-106).
 *
 * Parses .github/workflows/rk16c-two-manifest-preflight.yml (js-yaml) + robust
 * text/regex assertions. ZERO network, no creds, no production R2. Covers the
 * D-106 §17 build-stage static checks (1-21) + negative assertions. The fake
 * simulation (checks 22-25) is in rk16c-two-manifest-workflow-sim.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.resolve(HERE, '../../.github/workflows/rk16c-two-manifest-preflight.yml');
const OLD_WF_PATH = path.resolve(HERE, '../../.github/workflows/rk16c-manifest-preflight.yml');
const RAW = fs.readFileSync(WF_PATH, 'utf-8');
const DOC: any = yaml.load(RAW);

const AUDITED_RUNNER_SHA = '47b2672770708725b42f1b558391fc077a472848';
const SNAPSHOT = '2026-06-14/27502029137-1';
const ROOT_MANIFEST_KEY = 'snapshots/2026-06-14/27502029137-1/_snapshot.manifest.json';
const SIBLING_KEY = 'snapshots/2026-06-14/27502029137-1/manifest.json';
const PAYLOAD_KEY = 'snapshots/2026-06-14/27502029137-1/bioactivities.jsonl.gz';
const EXACT_CMD =
    'node scripts/spikes/rk16c/run-fullcorpus.mjs --preflight --execute '
    + `--snapshot ${SNAPSHOT} --manifest-key ${ROOT_MANIFEST_KEY}`;

function job() { return DOC.jobs['two-manifest-preflight']; }
function allUses(): string[] { return job().steps.filter((s: any) => s.uses).map((s: any) => s.uses); }

describe('D-106 check 1 — YAML parses + distinct identity', () => {
    it('parses with name/on/permissions/jobs', () => {
        expect(typeof DOC.name).toBe('string');
        expect(DOC.name).toBe('RK-16C Two-Manifest Preflight');
        expect(DOC.jobs && DOC.jobs['two-manifest-preflight']).toBeTruthy();
    });
    it('is a NEW file distinct from the spent old workflow', () => {
        expect(fs.existsSync(OLD_WF_PATH)).toBe(true); // old remains, untouched by this gate
        expect(WF_PATH).not.toBe(OLD_WF_PATH);
        expect(RAW).not.toContain('b0b8246e8ad77742d1aafd0720c5b4dd409d0b44'); // not the consumed runner
    });
});

describe('D-106 check 2/3/15 — trigger workflow_dispatch only, no inputs, forbidden triggers absent', () => {
    it('on is exactly workflow_dispatch', () => {
        const on = DOC.on ?? DOC[true as any];
        expect(on).toHaveProperty('workflow_dispatch');
        expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    });
    it('forbidden triggers absent (raw)', () => {
        for (const t of ['repository_dispatch', 'pull_request_target', 'workflow_call', 'workflow_run', 'schedule', 'release', 'deployment']) {
            expect(RAW.includes(`${t}:`)).toBe(false);
        }
        expect(/^\s+push:/m.test(RAW)).toBe(false);
        expect(/^\s+pull_request:/m.test(RAW)).toBe(false);
    });
    it('workflow_dispatch has NO inputs', () => {
        const on = DOC.on ?? DOC[true as any];
        expect(on.workflow_dispatch == null || on.workflow_dispatch.inputs == null).toBe(true);
        expect(/inputs:/.test(RAW)).toBe(false);
    });
});

describe('D-106 check 4/13 — permissions contents:read only; no write/OIDC', () => {
    it('permissions == { contents: read }', () => {
        expect(DOC.permissions).toEqual({ contents: 'read' });
    });
    it('no write scope, no id-token, no secrets:inherit', () => {
        expect(/^\s*[a-z-]+:\s*write\s*$/m.test(RAW)).toBe(false);
        expect(/^\s*id-token:/m.test(RAW)).toBe(false);
        expect(/^\s*secrets:\s*inherit\s*$/m.test(RAW)).toBe(false);
        expect((job() as any).secrets).toBeUndefined();
    });
});

describe('D-106 check 5/6/7 — environment, audited runner SHA, immutable action pins', () => {
    it('job bound to environment rk16c-manifest-preflight', () => {
        expect(job().environment).toBe('rk16c-manifest-preflight');
    });
    it('checkout ref == full final audited runner SHA + persist-credentials false', () => {
        const co = job().steps.find((s: any) => (s.uses || '').includes('actions/checkout'));
        expect(co.with.ref).toBe(AUDITED_RUNNER_SHA);
        expect(co.with['persist-credentials']).toBe(false);
    });
    it('every uses is a 40-hex immutable SHA pin (no floating tag)', () => {
        const uses = allUses();
        expect(uses.length).toBeGreaterThanOrEqual(3);
        for (const l of RAW.split('\n').filter((x) => /^\s*uses:/.test(x))) {
            const ref = l.split('@')[1].trim().split(/\s/)[0];
            expect(/^[0-9a-f]{40}$/.test(ref)).toBe(true);
        }
    });
    it('SHA-verify step exists, compares to AUDITED_RUNNER_SHA, exits 1, no bypass', () => {
        const v = job().steps.find((s: any) => /rev-parse HEAD/.test(s.run || ''));
        expect(v.env.AUDITED_RUNNER_SHA).toBe(AUDITED_RUNNER_SHA);
        expect(String(v.run)).toMatch(/!=\s*"\$\{AUDITED_RUNNER_SHA\}"/);
        expect(String(v.run)).toContain('exit 1');
        expect(v.if == null || v.if === true).toBe(true);
    });
});

describe('D-106 check 8/9/10/11 — exact snapshot/key/command; no sibling input; no payload', () => {
    it('exact snapshot + root-manifest key present', () => {
        expect(RAW.includes(`--snapshot ${SNAPSHOT}`)).toBe(true);
        expect(RAW.includes(`--manifest-key ${ROOT_MANIFEST_KEY}`)).toBe(true);
    });
    it('exact preflight command present verbatim', () => {
        const c = job().steps.find((s: any) => (s.run || '').includes('run-fullcorpus.mjs'));
        expect((c.run || '').trim()).toBe(EXACT_CMD);
    });
    it('sibling manifest.json is NOT a CLI/workflow input (derived internally)', () => {
        const runs = job().steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
        expect(runs.includes(`--manifest-key ${SIBLING_KEY}`)).toBe(false);
        expect(runs.includes(SIBLING_KEY)).toBe(false); // sibling never a shell arg
    });
    it('NO payload key / bioactivities.jsonl.gz in any run command', () => {
        const runs = job().steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
        expect(runs.includes(PAYLOAD_KEY)).toBe(false);
        expect(runs.includes('bioactivities.jsonl.gz')).toBe(false);
    });
});

describe('D-106 check 12/20/21 — no diagnostics; no generic --execute; no executeFullRun', () => {
    it('no List/aws/curl/wrangler/s3 diagnostic step', () => {
        const runs = job().steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
        for (const bad of ['aws s3', 's3 ls', 'aws ', 'curl ', 'wget ', 'wrangler', 'ListObjects', 'list-objects', 'rclone']) {
            expect(runs.includes(bad)).toBe(false);
        }
    });
    it('preflight precedes execute; no --full-run/--payload; executeFullRun absent', () => {
        expect(/--preflight[\s\S]*--execute/.test(RAW)).toBe(true);
        expect(RAW.includes('--full-run')).toBe(false);
        expect(RAW.includes('--payload')).toBe(false);
        expect(RAW.includes('executeFullRun')).toBe(false);
    });
});

describe('D-106 check 15/16 — event guard + run-attempt guard (correct semantics, FIRST)', () => {
    it('event guard is step 1 with event_name != workflow_dispatch + exit 1', () => {
        const s = job().steps[0];
        expect(String(s.if)).toContain("github.event_name != 'workflow_dispatch'");
        expect(String(s.run)).toContain('exit 1');
    });
    it('run-attempt guard before checkout with != 1 + exit 1', () => {
        const steps = job().steps;
        const gi = steps.findIndex((s: any) => /run_attempt/.test(JSON.stringify(s.if || '')));
        const ci = steps.findIndex((s: any) => (s.uses || '').includes('actions/checkout'));
        expect(gi).toBeGreaterThanOrEqual(0);
        expect(gi).toBeLessThan(ci);
        expect(String(steps[gi].if)).toContain("github.run_attempt != '1'");
        expect(String(steps[gi].run)).toContain('exit 1');
    });
});

describe('D-106 check 17/18/19 — concurrency, candidate-lock v2 artifact, bounded retention', () => {
    it('static concurrency group rk16c-two-manifest-preflight, no cancel, no expansion', () => {
        expect(DOC.concurrency.group).toBe('rk16c-two-manifest-preflight');
        expect(DOC.concurrency['cancel-in-progress']).toBe(false);
        expect(/group:.*\$\{\{/.test(RAW)).toBe(false);
    });
    it('artifact = ONLY the candidate lock; bounded retention <= 14; no glob/payload', () => {
        const up = job().steps.find((s: any) => (s.uses || '').includes('actions/upload-artifact'));
        expect(up.with.path).toBe('scripts/spikes/rk16c/results/RK16C_FULLCORPUS_LOCK.candidate.json');
        expect(Number.isInteger(up.with['retention-days'])).toBe(true);
        expect(up.with['retention-days']).toBeGreaterThan(0);
        expect(up.with['retention-days']).toBeLessThanOrEqual(14);
        expect(String(up.with.path).includes('*')).toBe(false);
        expect(String(up.with.path).includes('bioactivities')).toBe(false);
    });
    it('documents candidate-lock v2 UNRATIFIED + the A1 trust model', () => {
        expect(/candidate-lock( schema)? v2/i.test(RAW)).toBe(true);
        expect(RAW.includes('UNRATIFIED')).toBe(true);
        expect(/NOT AUTHORIZED FOR PAYLOAD READ/i.test(RAW)).toBe(true);
        expect(RAW.includes('root_directly_references_file_manifest=false')).toBe(true);
    });
});

describe('D-106 negative assertions — no dangerous patterns / bypasses', () => {
    it('no set -x / printenv / env dump / continue-on-error / || true', () => {
        const runs = job().steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
        expect(/set\s+-x/.test(runs)).toBe(false);
        expect(runs.includes('|| true')).toBe(false);
        expect(/printenv/.test(runs)).toBe(false);
        for (const s of job().steps) expect(s['continue-on-error']).not.toBe(true);
        expect(/continue-on-error:\s*true/.test(RAW)).toBe(false);
    });
});
