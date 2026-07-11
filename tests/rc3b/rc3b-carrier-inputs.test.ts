// @ts-nocheck
/**
 * RC-3B-P0B ONE shared carrier-input resolver (C1A-R1 / B1). resolveCarrierInputs
 * returns RESOLVED, real, in-root run-plan + template paths, anchored to the exact
 * checkout; a traversal / absolute-outside / symlink-escape path, or an unanchored
 * carrier-root override that escapes GITHUB_WORKSPACE, is REJECTED with [RC3B PATH]
 * BEFORE any file read. The `--check-authorization` CLI preflight applies it FIRST,
 * so a hostile path fails before ANY authorization anchor hash is read (proven via
 * stderr: [RC3B PATH], never [RC3B AUTHZ]/[RC3B IDENTITY]).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { resolveCarrierInputs, resolveCarrierRoot } from '../../scripts/rc3b-audit/carrier-inputs.mjs';
import { TEMPLATE_POLICY_PATH } from '../../scripts/rc3b-audit/template-policy.mjs';
import { authorizedScenario } from './rc3b-authorized-fixtures';

const mkdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));
function carrierRoot(tag = 'rc3b-ci-') {
    const root = mkdir(tag);
    const rp = path.join(root, 'run-plan.json');
    fs.writeFileSync(rp, JSON.stringify({ synthetic: true }), 'utf-8');
    const tp = path.join(root, 'template-policy.json');
    fs.copyFileSync(TEMPLATE_POLICY_PATH, tp);
    return { root, rp, tp };
}

describe('RC-3B-P0B resolveCarrierInputs: resolves in-root, rejects escapes', () => {
    it('returns FROZEN, RESOLVED, in-root paths for valid inputs', () => {
        const { root, rp, tp } = carrierRoot();
        const r = resolveCarrierInputs({ RC3B_CARRIER_ROOT: root, RC3B_RUN_PLAN_PATH: rp, RC3B_TEMPLATE_POLICY_PATH: tp });
        expect(r.rootDir).toBe(fs.realpathSync(root));
        expect(r.runPlanPath).toBe(fs.realpathSync(rp));
        expect(r.templatePolicyPath).toBe(fs.realpathSync(tp));
        expect(Object.isFrozen(r)).toBe(true);
    });

    it('rejects a ".." traversal run-plan path (before any read)', () => {
        const { root } = carrierRoot();
        const traversal = `${root}${path.sep}..${path.sep}run-plan.json`;
        expect(() => resolveCarrierInputs({ RC3B_CARRIER_ROOT: root, RC3B_RUN_PLAN_PATH: traversal })).toThrow(/RC3B PATH/);
    });

    it('rejects an absolute run-plan path OUTSIDE the root', () => {
        const { root } = carrierRoot();
        const out = mkdir('rc3b-ci-out-');
        const evil = path.join(out, 'evil.json');
        fs.writeFileSync(evil, '{}');
        expect(() => resolveCarrierInputs({ RC3B_CARRIER_ROOT: root, RC3B_RUN_PLAN_PATH: evil })).toThrow(/RC3B PATH/);
    });

    it('rejects a symlink/junction run-plan path whose real target ESCAPES the root', () => {
        const { root } = carrierRoot();
        const out = mkdir('rc3b-ci-out-');
        fs.writeFileSync(path.join(out, 'evil.json'), '{}');
        const link = path.join(root, 'link');
        let linked = false;
        try { fs.symlinkSync(out, link, 'junction'); linked = true; } catch { linked = false; }
        if (!linked) return; // symlink privilege unavailable
        const escape = path.join(link, 'evil.json');
        expect(() => resolveCarrierInputs({ RC3B_CARRIER_ROOT: root, RC3B_RUN_PLAN_PATH: escape })).toThrow(/RC3B PATH/);
    });
});

describe('RC-3B-P0B resolveCarrierRoot: GITHUB_WORKSPACE anchoring', () => {
    it('anchors to GITHUB_WORKSPACE and accepts an override INSIDE it', () => {
        const { root } = carrierRoot('rc3b-ws-');
        expect(resolveCarrierRoot({ GITHUB_WORKSPACE: root })).toBe(fs.realpathSync(root));
        expect(resolveCarrierRoot({ GITHUB_WORKSPACE: root, RC3B_CARRIER_ROOT: root })).toBe(fs.realpathSync(root));
    });

    it('REJECTS an unanchored override that escapes the workspace (not /, a parent, or another checkout)', () => {
        const { root } = carrierRoot('rc3b-ws-');
        const other = mkdir('rc3b-ws-other-');
        expect(() => resolveCarrierRoot({ GITHUB_WORKSPACE: root, RC3B_CARRIER_ROOT: other })).toThrow(/RC3B PATH/);
        const parent = path.dirname(fs.realpathSync(root));
        expect(() => resolveCarrierRoot({ GITHUB_WORKSPACE: root, RC3B_CARRIER_ROOT: parent })).toThrow(/RC3B PATH/);
    });
});

describe('RC-3B-P0B --check-authorization CLI preflight: path-safety is the EARLIEST gate', () => {
    const runCli = (env) => spawnSync(process.execPath, ['scripts/rc3b-audit/run.mjs', '--check-authorization'],
        { cwd: process.cwd(), env, encoding: 'utf-8' });

    it('a ".." traversal run-plan path fails with [RC3B PATH] BEFORE any authorization hash read', () => {
        const scn = authorizedScenario();
        const traversal = `${scn.dir}${path.sep}..${path.sep}run-plan.json`;
        const env = { ...process.env, ...scn.env, RC3B_RUN_PLAN_PATH: traversal };
        delete env.GITHUB_WORKSPACE; // isolate: rootDir = scn.dir carrier override
        const r = runCli(env);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/\[RC3B PATH\]/);
        // Proof it failed at path-safety, not a later anchor / identity check.
        expect(r.stderr).not.toMatch(/\[RC3B AUTHZ\]/);
        expect(r.stderr).not.toMatch(/\[RC3B IDENTITY\]/);
    });

    it('valid in-root paths + full anchors -> PASS (exit 0)', () => {
        const scn = authorizedScenario();
        const env = { ...process.env, ...scn.env };
        delete env.GITHUB_WORKSPACE;
        const r = runCli(env);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/AUTHZ\] PASS/);
    });

    it('offline (no anchors) exits 2', () => {
        const env = { ...process.env };
        delete env.RC3B_P0B_RUN_AUTHORIZED;
        delete env.RC3B_RUN_PLAN_PATH;
        delete env.GITHUB_WORKSPACE;
        const r = runCli(env);
        expect(r.status).toBe(2);
    });
});
